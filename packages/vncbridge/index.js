#!/usr/bin/env node

import { io } from 'socket.io-client';
import net from 'node:net';
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

const c = colors;

function getVersion() {
    try {
        const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
        return pkg.version || '1.0.0';
    } catch {
        return '1.0.0';
    }
}

const VERSION = getVersion();
const DEFAULT_PORT = 5900;

function printBanner() {
    console.log();
    console.log(`  ${c.bold}${c.cyan}V87${c.reset} ${c.dim}VNC Bridge v${VERSION}${c.reset}`);
    console.log(`  ${c.dim}────────────────────────────${c.reset}`);
    console.log();
}

function printHelp() {
    printBanner();
    console.log(`  ${c.bold}USAGE${c.reset}`);
    console.log(`    ${c.dim}$${c.reset} vncbridge [options] [connection-code]`);
    console.log();
    console.log(`  ${c.bold}OPTIONS${c.reset}`);
    console.log(`    ${c.cyan}-p, --port${c.reset} <port>      Local VNC port to listen on ${c.dim}(default: 5900)${c.reset}`);
    console.log(`    ${c.cyan}-c, --code${c.reset} <code>      Connection code from v87 panel`);
    console.log(`    ${c.cyan}--help${c.reset}                 Show this help message`);
    console.log(`    ${c.cyan}--version${c.reset}              Show version number`);
    console.log();
    console.log(`  ${c.bold}EXAMPLES${c.reset}`);
    console.log(`    ${c.dim}$${c.reset} vncbridge`);
    console.log(`    ${c.dim}$${c.reset} vncbridge -p 5901 -c ${c.yellow}"eyJ1cmwiOi..."${c.reset}`);
    console.log(`    ${c.dim}$${c.reset} vncbridge ${c.yellow}"eyJ1cmwiOi..."${c.reset}`);
    console.log();
    console.log(`  ${c.bold}HOW IT WORKS${c.reset}`);
    console.log(`    ${c.dim}1.${c.reset} Get connection code from v87 panel (VM → VNC → Bridge Code)`);
    console.log(`    ${c.dim}2.${c.reset} Run this bridge with the code`);
    console.log(`    ${c.dim}3.${c.reset} Connect your VNC client to 127.0.0.1:<port>`);
    console.log();
}

function printVersion() {
    console.log(`v87 vnc bridge v${VERSION}`);
}

function log(type, message) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const prefix = {
        info: `${c.blue}●${c.reset}`,
        success: `${c.green}✓${c.reset}`,
        warn: `${c.yellow}⚠${c.reset}`,
        error: `${c.red}✗${c.reset}`
    };
    console.log(`  ${c.dim}${timestamp}${c.reset}  ${prefix[type] || prefix.info}  ${message}`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        port: DEFAULT_PORT,
        code: null
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];

        switch (arg) {
            case '-p':
            case '--port':
                options.port = parseInt(next, 10);
                if (isNaN(options.port) || options.port < 1 || options.port > 65535) {
                    console.log();
                    log('error', `Invalid port: ${c.bold}${next}${c.reset}`);
                    console.log();
                    process.exit(1);
                }
                i++;
                break;
            case '-c':
            case '--code':
                options.code = next;
                i++;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
            case '--version':
            case '-v':
                printVersion();
                process.exit(0);
            default:
                if (!arg.startsWith('-') && !options.code) {
                    options.code = arg;
                } else if (arg.startsWith('-')) {
                    console.log();
                    log('error', `Unknown option: ${c.bold}${arg}${c.reset}`);
                    console.log();
                    console.log(`  ${c.dim}Run${c.reset} vncbridge --help ${c.dim}for usage${c.reset}`);
                    console.log();
                    process.exit(1);
                }
        }
    }

    return options;
}

function printConfig(config, port) {
    console.log(`  ${c.bold}Configuration${c.reset}`);
    console.log(`  ${c.dim}─────────────────────────────${c.reset}`);
    console.log(`  ${c.dim}Server${c.reset}    ${c.cyan}${config.serverId}${c.reset}`);
    console.log(`  ${c.dim}Address${c.reset}   ${c.cyan}127.0.0.1:${port}${c.reset}`);
    console.log();
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
        rl.question(`  ${c.cyan}?${c.reset} Enter connection code from v87 panel:\n  > `, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

    async start() {
        this.server = net.createServer((client) => {
            this.handleClient(client);
        });

        this.server.listen(this.localPort, '127.0.0.1', () => {
            log('success', `Listening on ${c.cyan}127.0.0.1:${this.localPort}${c.reset}`);
            console.log();
            log('info', `${c.dim}Press Ctrl+C to stop${c.reset}`);
            console.log();
        });

        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                log('error', `Port ${c.bold}${this.localPort}${c.reset} is already in use`);
                console.log();
                console.log(`  ${c.dim}Try using a different port with${c.reset} -p <port>`);
                console.log();
            } else {
                log('error', `Server error: ${err.message}`);
            }
            process.exit(1);
        });
    }

    handleClient(client) {
        if (this.activeSession) {
            log('warn', 'Rejected connection - session already active');
            client.destroy();
            return;
        }

        this.stats.connections++;
        log('info', `VNC client connected ${c.dim}(#${this.stats.connections})${c.reset}`);
        log('info', 'Connecting to panel...');

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
            log('success', 'Connected to v87 panel');
        });

        socket.on('vnc-connected', () => {
            log('success', 'VNC session established');
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
            log('warn', 'VNC session ended by server');
            this.cleanup(sessionBytesIn, sessionBytesOut);
        });

        socket.on('error', (err) => {
            log('error', `WebSocket error: ${err.message || err}`);
            this.cleanup(sessionBytesIn, sessionBytesOut);
        });

        socket.on('disconnect', (reason) => {
            if (reason !== 'io client disconnect') {
                log('warn', `Disconnected: ${reason}`);
            }
            this.cleanup(sessionBytesIn, sessionBytesOut);
        });

        socket.on('connect_error', (err) => {
            log('error', `Connection failed: ${err.message}`);
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
            log('info', 'VNC client disconnected');
            this.cleanup(sessionBytesIn, sessionBytesOut);
        });

        client.on('error', (err) => {
            if (err.code !== 'ECONNRESET') {
                log('error', `Client error: ${err.message}`);
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
            log('info', `${c.dim}Session: ↓${formatBytes(bytesIn)} ↑${formatBytes(bytesOut)}${c.reset}`);
        }
        log('info', 'Ready for new connection');
        console.log();
    }

    stop() {
        console.log();
        log('warn', 'Shutting down...');

        this.cleanup();

        if (this.server) {
            this.server.close();
        }

        console.log();
        console.log(`  ${c.bold}Session Stats${c.reset}`);
        console.log(`  ${c.dim}─────────────────────────────${c.reset}`);
        console.log(`  ${c.dim}Connections${c.reset}   ${c.cyan}${this.stats.connections}${c.reset}`);
        console.log(`  ${c.dim}Data${c.reset}          ${c.cyan}↓${formatBytes(this.stats.bytesIn)} ↑${formatBytes(this.stats.bytesOut)}${c.reset}`);
        console.log();
        log('success', 'Bridge stopped');
        console.log();
    }
}

async function main() {
    const options = parseArgs();

    printBanner();

    let code = options.code;
    if (!code) {
        code = await promptCode();
        console.log();
    }

    if (!code) {
        log('error', 'No connection code provided');
        console.log();
        console.log(`  ${c.dim}Run${c.reset} vncbridge --help ${c.dim}for usage${c.reset}`);
        console.log();
        process.exit(1);
    }

    let config;
    try {
        config = decodeConnectionCode(code);
        log('success', 'Connection code validated');
    } catch (e) {
        log('error', e.message);
        console.log();
        process.exit(1);
    }

    console.log();
    printConfig(config, options.port);

    log('info', 'Starting bridge...');

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
    log('error', `Fatal: ${err.message}`);
    process.exit(1);
});
