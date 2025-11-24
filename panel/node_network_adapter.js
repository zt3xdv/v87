import net from "node:net";
import {
    create_eth_encoder_buf,
    handle_fake_networking,
    TCPConnection,
    TCP_STATE_SYN_RECEIVED,
    TCP_STATE_ESTABLISHED,
    TCP_STATE_CLOSED,
    fake_tcp_connect,
    fake_tcp_probe
} from "../src/browser/fake_network.js";

export function NodeNetworkAdapter(bus, config)
{
    config = config || {};
    this.bus = bus;
    this.id = config.id || 0;
    this.router_mac = new Uint8Array((config.router_mac || "52:54:0:1:2:3").split(":").map(function(x) { return parseInt(x, 16); }));
    this.router_ip = new Uint8Array((config.router_ip || "192.168.86.1").split(".").map(function(x) { return parseInt(x, 10); }));
    this.vm_ip = new Uint8Array((config.vm_ip || "192.168.86.100").split(".").map(function(x) { return parseInt(x, 10); }));
    this.masquerade = config.masquerade === undefined || !!config.masquerade;
    this.vm_mac = new Uint8Array(6);
    this.dns_method = "doh"; 
    this.doh_server = config.doh_server || "8.8.8.8";
    this.tcp_conn = {};
    this.eth_encoder_buf = create_eth_encoder_buf();
    
    this.stats = { rx: 0, tx: 0 };

    this.bus.register("net" + this.id + "-mac", function(mac) {
        this.vm_mac = new Uint8Array(mac.split(":").map(function(x) { return parseInt(x, 16); }));
    }, this);
    this.bus.register("net" + this.id + "-send", function(data)
    {
        this.send(data);
    }, this);
}

NodeNetworkAdapter.prototype.destroy = function()
{
    Object.values(this.tcp_conn).forEach(conn => {
        if(conn.socket) conn.socket.destroy();
    });
};

NodeNetworkAdapter.prototype.on_tcp_connection = function(packet, tuple)
{
    const dest_ip = packet.ipv4.dest.join(".");
    const dest_port = packet.tcp.dport;

    let conn = new TCPConnection();
    conn.state = TCP_STATE_SYN_RECEIVED;
    conn.net = this;
    conn.tuple = tuple;
    
    const socket = new net.Socket();
    conn.socket = socket;

    conn.on("data", (data) => {
        if (!socket.destroyed && !socket.connecting) {
            socket.write(Buffer.from(data));
        }
    });

    conn.on("close", () => {
        if (!socket.destroyed) socket.end();
    });

    conn.on("shutdown", () => {
        if (!socket.destroyed) socket.end();
    });

    socket.on("connect", () => {
        conn.accept(packet);
        this.tcp_conn[tuple] = conn;
    });

    socket.on("data", (data) => {
        conn.write(new Uint8Array(data));
    });

    socket.on("end", () => {
        conn.close();
    });

    socket.on("error", (err) => {
        if (conn.state !== TCP_STATE_CLOSED) {
             conn.release(); 
        }
    });

    socket.on("close", () => {
        if (conn.state !== TCP_STATE_CLOSED) {
            conn.close();
        }
    });

    socket.connect(dest_port, dest_ip);

    return true; 
};

NodeNetworkAdapter.prototype.connect = function(port)
{
    return fake_tcp_connect(port, this);
};

NodeNetworkAdapter.prototype.tcp_probe = function(port)
{
    return fake_tcp_probe(port, this);
};

NodeNetworkAdapter.prototype.send = function(data)
{
    this.stats.tx += data.length;
    handle_fake_networking(data, this);
};

NodeNetworkAdapter.prototype.receive = function(data)
{
    this.stats.rx += data.length;
    this.bus.send("net" + this.id + "-receive", new Uint8Array(data));
};
