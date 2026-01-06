#!/usr/bin/env node

import { io } from 'socket.io-client';
import net from 'node:net';
import readline from 'node:readline';

const VERSION = '1.0.0';
const DEFAULT_PORT = 5900;

const TERM_GRAY = '\x1b[90m';
const TERM_GREEN = '\x1b[32m';
const TERM_YELLOW = '\x1b[33m';
const TERM_RED = '\x1b[31m';
const TERM_CYAN = '\x1b[36m';
const TERM_BOLD = '\x1b[1m';
const TERM_RESET = '\x1b[0m';

function log(message) {
    const now = new Date();
    const H = String(now.getHours()).padStart(2, '0');
    const M = String(now.getMinutes()).padStart(2, '0');
    const S = String(now.getSeconds()).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const y = String(now.getFullYear()).slice(-2);
    
    console.log(`${TERM_GRAY}${H}:${M}:${S} ${d}/${m}/${y} ${TERM_RESET}${message}`);
}

function logSuccess(message) {
    log(`${TERM_GREEN}✓${TERM_RESET} ${message}`);
}

function logError(message) {
    log(`${TERM_RED}✗${TERM_RESET} ${message}`);
}

function logWarn(message) {
    log(`${TERM_YELLOW}!${TERM_RESET} ${message}`);
}

function logInfo(message) {
    log(`${TERM_CYAN}→${TERM_RESET} ${message}`);
}

function showBanner() {
    console.log(`
${TERM_BOLD}${TERM_CYAN}┌─────────────────────────────────────┐
│          v87 VNC Bridge             │
│             v${VERSION}                  │
└─────────────────────────────────────┘${TERM_RESET}
`);
}

function showHelp() {
    console.log(`${TERM_BOLD}v87 VNC Bridge${TERM_RESET} - Bridge VNC from v87 panel to local VNC client

${TERM_BOLD}USAGE${TERM_RESET}
  vncbridge [options] [connection-code]

${TERM_BOLD}OPTIONS${TERM_RESET}
  ${TERM_CYAN}-p, --port${TERM_RESET} <port>    Local VNC port to listen on (default: 5900)
  ${TERM_CYAN}-c, --code${TERM_RESET} <code>    Connection code from v87 panel
  ${TERM_CYAN}-h, --help${TERM_RESET}           Show this help message
  ${TERM_CYAN}-v, --version${TERM_RESET}        Show version number

${TERM_BOLD}EXAMPLES${TERM_RESET}
  ${TERM_GRAY}# Interactive mode (will prompt for code)${TERM_RESET}
  vncbridge

  ${TERM_GRAY}# Specify port and code${TERM_RESET}
  vncbridge -p 5901 -c "eyJ1cmwiOi..."

  ${TERM_GRAY}# Code as positional argument${TERM_RESET}
  vncbridge "eyJ1cmwiOi..."

${TERM_BOLD}HOW IT WORKS${TERM_RESET}
  1. Get connection code from v87 panel (VM → VNC → Bridge Code)
  2. Run this bridge with the code
  3. Connect your VNC client to 127.0.0.1:<port>
`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        port: DEFAULT_PORT,
        code: null,
        help: false,
        version: false
    };
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '-p' || arg === '--port') {
            const port = parseInt(args[++i]);
            if (isNaN(port) || port < 1 || port > 65535) {
                console.error(`${TERM_RED}Error: Invalid port number${TERM_RESET}`);
                process.exit(1);
            }
            options.port = port;
        } else if (arg === '-c' || arg === '--code') {
            options.code = args[++i];
        } else if (arg === '-h' || arg === '--help') {
            options.help = true;
        } else if (arg === '-v' || arg === '--version') {
            options.version = true;
        } else if (!arg.startsWith('-') && !options.code) {
            options.code = arg;
        } else if (arg.startsWith('-')) {
            console.error(`${TERM_RED}Error: Unknown option '${arg}'${TERM_RESET}`);
            console.error(`Run 'vncbridge --help' for usage`);
            process.exit(1);
        }
    }
    
    return options;
}

function decodeConnectionCode(code) {
    try {
        const decoded = Buffer.from(code, 'base64').toString('utf-8');
        const data = JSON.parse(decoded);
        
        if (!data.url || !data.token || !data.serverId) {
            throw new Error('Missing required fields');
        }
        
        return data;
    } catch (e) {
        throw new Error(`Invalid connection code: ${e.message}`);
    }
}

async function promptCode() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    return new Promise((resolve) => {
        rl.question(`${TERM_CYAN}?${TERM_RESET} Enter connection code from v87 panel:\n> `, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

class VNCBridge {
    constructor(config, localPort) {
        this.config = config;
        this.localPort = localPort;
        this.server = null;
        this.activeSession = null;
        this.stats = {
            bytesIn: 0,
            bytesOut: 0,
            connections: 0
        };
    }
    
    formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    
    async start() {
        this.server = net.createServer((client) => {
            this.handleClient(client);
        });
        
        this.server.listen(this.localPort, '127.0.0.1', () => {
            console.log(`${TERM_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${TERM_RESET}`);
            console.log(`${TERM_BOLD} VNC Bridge Ready${TERM_RESET}`);
            console.log(`${TERM_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${TERM_RESET}`);
            console.log(` Server:  ${TERM_CYAN}${this.config.serverId}${TERM_RESET}`);
            console.log(` Address: ${TERM_CYAN}127.0.0.1:${this.localPort}${TERM_RESET}`);
            console.log(`${TERM_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${TERM_RESET}`);
            console.log(`${TERM_GRAY} Press Ctrl+C to stop${TERM_RESET}\n`);
        });
        
        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logError(`Port ${this.localPort} is already in use`);
                console.log(`${TERM_GRAY}   Try using a different port with -p <port>${TERM_RESET}`);
            } else {
                logError(`Server error: ${err.message}`);
            }
            process.exit(1);
        });
    }
    
    handleClient(client) {
        if (this.activeSession) {
            logWarn('Rejected connection - session already active');
            client.destroy();
            return;
        }
        
        this.stats.connections++;
        logInfo(`VNC client connected (#${this.stats.connections})`);
        logInfo(`Connecting to panel...`);
        
        const socket = io(`${this.config.url}/vnc`, {
            auth: { token: this.config.token },
            query: { serverId: this.config.serverId },
            transports: ['websocket'],
            reconnection: false,
            timeout: 10000
        });
        
        this.activeSession = { client, socket };
        let vncConnected = false;
        let sessionBytesIn = 0;
        let sessionBytesOut = 0;
        
        socket.on('connect', () => {
            logSuccess('Connected to v87 panel');
        });
        
        socket.on('vnc-connected', () => {
            logSuccess('VNC session established');
            vncConnected = true;
        });
        
        socket.on('vnc-data', (data) => {
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
            
            sessionBytesIn += bytes.length;
            this.stats.bytesIn += bytes.length;
            
            if (!client.destroyed) {
                client.write(bytes);
            }
        });
        
        socket.on('vnc-disconnected', () => {
            logWarn('VNC session ended by server');
            this.cleanup(sessionBytesIn, sessionBytesOut);
        });
        
        socket.on('error', (err) => {
            logError(`WebSocket error: ${err.message || err}`);
            this.cleanup(sessionBytesIn, sessionBytesOut);
        });
        
        socket.on('disconnect', (reason) => {
            if (reason !== 'io client disconnect') {
                logWarn(`Disconnected: ${reason}`);
            }
            this.cleanup(sessionBytesIn, sessionBytesOut);
        });
        
        socket.on('connect_error', (err) => {
            logError(`Connection failed: ${err.message}`);
            this.cleanup(sessionBytesIn, sessionBytesOut);
        });
        
        client.on('data', (data) => {
            sessionBytesOut += data.length;
            this.stats.bytesOut += data.length;
            
            if (socket.connected && vncConnected) {
                socket.emit('vnc-data', Array.from(data));
            }
        });
        
        client.on('close', () => {
            logInfo('VNC client disconnected');
            this.cleanup(sessionBytesIn, sessionBytesOut);
        });
        
        client.on('error', (err) => {
            if (err.code !== 'ECONNRESET') {
                logError(`Client error: ${err.message}`);
            }
            this.cleanup(sessionBytesIn, sessionBytesOut);
        });
    }
    
    cleanup(bytesIn = 0, bytesOut = 0) {
        if (!this.activeSession) return;
        
        const { client, socket } = this.activeSession;
        this.activeSession = null;
        
        if (socket) {
            socket.disconnect();
        }
        
        if (client && !client.destroyed) {
            client.destroy();
        }
        
        if (bytesIn > 0 || bytesOut > 0) {
            log(`${TERM_GRAY}   Session: ↓${this.formatBytes(bytesIn)} ↑${this.formatBytes(bytesOut)}${TERM_RESET}`);
        }
        logInfo('Ready for new connection\n');
    }
    
    stop() {
        console.log('');
        log(`${TERM_BOLD}Stopping bridge...${TERM_RESET}`);
        
        this.cleanup();
        
        if (this.server) {
            this.server.close();
        }
        
        console.log(`${TERM_GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${TERM_RESET}`);
        console.log(` Total connections: ${this.stats.connections}`);
        console.log(` Data transferred:  ↓${this.formatBytes(this.stats.bytesIn)} ↑${this.formatBytes(this.stats.bytesOut)}`);
        console.log(`${TERM_GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${TERM_RESET}`);
        logSuccess('Bridge stopped');
    }
}

async function main() {
    const options = parseArgs();
    
    if (options.version) {
        console.log(`v87 VNC Bridge v${VERSION}`);
        process.exit(0);
    }
    
    if (options.help) {
        showHelp();
        process.exit(0);
    }
    
    showBanner();
    
    let code = options.code;
    if (!code) {
        code = await promptCode();
        console.log('');
    }
    
    if (!code) {
        logError('No connection code provided');
        process.exit(1);
    }
    
    let config;
    try {
        config = decodeConnectionCode(code);
        logSuccess('Connection code validated');
    } catch (e) {
        logError(e.message);
        process.exit(1);
    }
    
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
    logError(`Fatal: ${err.message}`);
    process.exit(1);
});
