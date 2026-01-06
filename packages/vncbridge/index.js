#!/usr/bin/env node

import { io } from 'socket.io-client';
import net from 'node:net';
import readline from 'node:readline';

const DEFAULT_PORT = 5900;

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        port: DEFAULT_PORT,
        code: null
    };
    
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-p' || args[i] === '--port') {
            options.port = parseInt(args[++i]) || DEFAULT_PORT;
        } else if (args[i] === '-c' || args[i] === '--code') {
            options.code = args[++i];
        } else if (args[i] === '-h' || args[i] === '--help') {
            console.log(`
vncbridge - Bridge VNC from v87 web panel to local VNC client

Usage: vncbridge [options]

Options:
  -p, --port <port>   Local VNC port (default: 5900)
  -c, --code <code>   Connection code from v87 panel
  -h, --help          Show this help

Example:
  vncbridge -p 5901 -c "abc123..."
  vncbridge  # Will prompt for code
`);
            process.exit(0);
        } else if (!options.code) {
            options.code = args[i];
        }
    }
    
    return options;
}

function decodeConnectionCode(code) {
    try {
        const decoded = Buffer.from(code, 'base64').toString('utf-8');
        const data = JSON.parse(decoded);
        
        if (!data.url || !data.token || !data.serverId) {
            throw new Error('Invalid code format');
        }
        
        return data;
    } catch (e) {
        throw new Error('Invalid connection code: ' + e.message);
    }
}

async function promptCode() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    return new Promise((resolve) => {
        rl.question('Enter connection code from v87 panel: ', (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

class VNCBridge {
    constructor(config, localPort) {
        this.config = config;
        this.localPort = localPort;
        this.socket = null;
        this.server = null;
        this.clients = new Set();
        this.vncConnected = false;
        this.buffer = [];
    }
    
    async start() {
        console.log(`Connecting to ${this.config.url}...`);
        
        // Connect to web VNC
        this.socket = io(`${this.config.url}/vnc`, {
            auth: { token: this.config.token },
            query: { serverId: this.config.serverId },
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });
        
        this.socket.on('connect', () => {
            console.log('Connected to v87 panel');
        });
        
        this.socket.on('vnc-connected', () => {
            console.log('VNC session established');
            this.vncConnected = true;
            
            // Send buffered data to new clients
            if (this.buffer.length > 0) {
                const combined = Buffer.concat(this.buffer);
                this.clients.forEach(client => {
                    if (!client.destroyed) {
                        client.write(combined);
                    }
                });
            }
        });
        
        this.socket.on('vnc-data', (data) => {
            let bytes;
            if (data instanceof ArrayBuffer) {
                bytes = Buffer.from(data);
            } else if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
                bytes = Buffer.from(data.data);
            } else if (Array.isArray(data)) {
                bytes = Buffer.from(data);
            } else {
                bytes = Buffer.from(data);
            }
            
            // Store in buffer for new clients
            this.buffer.push(bytes);
            if (this.buffer.length > 100) {
                this.buffer.shift();
            }
            
            // Forward to all local VNC clients
            this.clients.forEach(client => {
                if (!client.destroyed) {
                    client.write(bytes);
                }
            });
        });
        
        this.socket.on('vnc-disconnected', () => {
            console.log('VNC session disconnected');
            this.vncConnected = false;
            this.clients.forEach(client => client.destroy());
            this.clients.clear();
        });
        
        this.socket.on('error', (err) => {
            console.error('Connection error:', err);
        });
        
        this.socket.on('disconnect', (reason) => {
            console.log('Disconnected:', reason);
            this.vncConnected = false;
        });
        
        // Create local VNC server
        this.server = net.createServer((client) => {
            console.log('Local VNC client connected');
            this.clients.add(client);
            
            client.on('data', (data) => {
                // Forward to web VNC
                if (this.socket && this.vncConnected) {
                    this.socket.emit('vnc-data', Array.from(data));
                }
            });
            
            client.on('close', () => {
                console.log('Local VNC client disconnected');
                this.clients.delete(client);
            });
            
            client.on('error', (err) => {
                console.error('Client error:', err.message);
                this.clients.delete(client);
            });
        });
        
        this.server.listen(this.localPort, '127.0.0.1', () => {
            console.log(`\nVNC bridge ready!`);
            console.log(`Connect your VNC client to: 127.0.0.1:${this.localPort}`);
            console.log(`\nPress Ctrl+C to stop\n`);
        });
        
        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`Port ${this.localPort} is already in use`);
            } else {
                console.error('Server error:', err.message);
            }
            process.exit(1);
        });
    }
    
    stop() {
        console.log('\nStopping bridge...');
        
        this.clients.forEach(client => client.destroy());
        this.clients.clear();
        
        if (this.socket) {
            this.socket.disconnect();
        }
        
        if (this.server) {
            this.server.close();
        }
        
        console.log('Bridge stopped');
    }
}

async function main() {
    const options = parseArgs();
    
    let code = options.code;
    if (!code) {
        code = await promptCode();
    }
    
    if (!code) {
        console.error('No connection code provided');
        process.exit(1);
    }
    
    let config;
    try {
        config = decodeConnectionCode(code);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
    
    console.log(`Server: ${config.serverId}`);
    
    const bridge = new VNCBridge(config, options.port);
    
    process.on('SIGINT', () => {
        bridge.stop();
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        bridge.stop();
        process.exit(0);
    });
    
    await bridge.start();
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
