import fs from "node:fs";
import url from "node:url";
import path from "node:path";
import { V86 } from "../src/main.js";
import { NodeNetworkAdapter } from "./node_network_adapter.js";
import { handle9p } from "../src/node_9p_handler.js";
import { LOG_NONE } from "../src/const.js";

const TERM_YELLOW_BOLD = "\x1b[1;33m";
const TERM_RED_BOLD = "\x1b[1;31m";
const TERM_RESET = "\x1b[0m";

const args = process.argv.slice(2);
const memorySize = parseInt(args[0]) || 128; 
const isoPath = args[1] || "images/alpine.iso";
const rootPath = args[2] || "root";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");

const biosPath = path.join(workspaceRoot, "bios/seabios.bin");
const vgaBiosPath = path.join(workspaceRoot, "bios/vgabios.bin");
const wasmPath = path.join(workspaceRoot, "build/v86.wasm");
//const bzimagePath = path.join(workspaceRoot, "images/buildroot-bzimage68.bin");
const cdromPath = path.isAbsolute(isoPath) ? isoPath : path.join(workspaceRoot, isoPath);

console.log(`${TERM_YELLOW_BOLD}[v87 Daemon] Starting up...${TERM_RESET}`);

const emulator = new V86({
    bios: { url: biosPath },
    vga_bios: { url: vgaBiosPath },
    //bzimage: { url: bzimagePath },
    cdrom: { url: cdromPath },
    filesystem: {
        handle9p: handle9p
    },
    log_level: LOG_NONE,
    memory_size: memorySize * 1024 * 1024,
    wasm_path: wasmPath,
    autostart: true
});

const netAdapter = new NodeNetworkAdapter(emulator.bus);

let serial_buffer = "";
let mounted = false;

emulator.add_listener("serial0-output-byte", function(byte) {
    const chr = String.fromCharCode(byte);
    process.stdout.write(chr);

    if(chr <= "~") {
        serial_buffer += chr;
        if(serial_buffer.length > 100) serial_buffer = serial_buffer.slice(-100);

        if(!mounted && serial_buffer.endsWith("~% ")) {
            mounted = true;
            const cmd = "ifconfig eth0 192.168.86.100 netmask 255.255.255.0 up; " +
                        "route add default gw 192.168.86.1; " +
                        "echo 'nameserver 192.168.86.1' > /etc/resolv.conf; " +
                        "umount /mnt; " +
                        "mount -t 9p -o trans=virtio,version=9p2000.L,access=any host9p /root; " +
                        "cd ..; cd root; clear; " +
                        "echo -e \"\\033[1;33m[v87 Daemon] Server marked as started.\\033[0m\"\n";
            emulator.serial0_send(cmd);
        }
    }
});

if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}

process.stdin.resume();
process.stdin.setEncoding("utf8");

process.stdin.on("data", function(c) {
    if(c === "\u0003") {
        emulator.destroy();
        process.exit();
    } else {
        emulator.serial0_send(c);
    }
});

process.on('uncaughtException', (err) => {
    console.error(`${TERM_RED_BOLD}[v87 Daemon] Error: ${err.message}${TERM_RESET}`);
    process.exit(1);
});

setInterval(() => {
    const ram = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (process.send) {
        process.send({
            type: 'stats',
            ram,
            netRx: netAdapter.stats.rx,
            netTx: netAdapter.stats.tx
        });
    }
}, 1000);
