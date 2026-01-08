import { NodeDaemon } from './daemon.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

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
        const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
        return pkg.version || '1.0.0';
    } catch {
        return '1.0.0';
    }
}

const VERSION = getVersion();

function printBanner() {
    console.log();
    console.log(`  ${c.bold}${c.cyan}V87${c.reset} ${c.dim}Node Daemon v${VERSION}${c.reset}`);
    console.log(`  ${c.dim}────────────────────────────${c.reset}`);
    console.log();
}

function printHelp() {
    printBanner();
    console.log(`  ${c.bold}USAGE${c.reset}`);
    console.log(`    ${c.dim}$${c.reset} npm run start:node -- [options]`);
    console.log();
    console.log(`  ${c.bold}OPTIONS${c.reset}`);
    console.log(`    ${c.cyan}-p, --port${c.reset} <port>      Port to listen on ${c.dim}(default: 7000)${c.reset}`);
    console.log(`    ${c.cyan}-h, --host${c.reset} <host>      Host to bind to ${c.dim}(default: 0.0.0.0)${c.reset}`);
    console.log(`    ${c.cyan}-s, --secret${c.reset} <key>     Secret key for authentication ${c.red}(required)${c.reset}`);
    console.log(`    ${c.cyan}-d, --data${c.reset} <dir>       Data directory for VMs ${c.dim}(default: ./data)${c.reset}`);
    console.log(`    ${c.cyan}--kvm${c.reset}                  Enable KVM acceleration`);
    console.log(`    ${c.cyan}--help${c.reset}                 Show this help message`);
    console.log(`    ${c.cyan}--version${c.reset}              Show version number`);
    console.log();
    console.log(`  ${c.bold}EXAMPLES${c.reset}`);
    console.log(`    ${c.dim}$${c.reset} npm run start:node -- -p 7000 -s ${c.yellow}mysecretkey${c.reset}`);
    console.log(`    ${c.dim}$${c.reset} npm run start:node -- --port 7000 --secret ${c.yellow}mysecret${c.reset} --kvm`);
    console.log(`    ${c.dim}$${c.reset} npm run start:node -- -p 7000 -s ${c.yellow}secret${c.reset} -d /var/lib/v87`);
    console.log();
}

function printVersion() {
    console.log(`v87 node daemon v${VERSION}`);
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

function parseArgs(args) {
    const config = {
        port: 7000,
        host: '0.0.0.0',
        secret: null,
        dataDir: './data',
        enableKvm: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];

        switch (arg) {
            case '-p':
            case '--port':
                config.port = parseInt(next, 10);
                if (isNaN(config.port) || config.port < 1 || config.port > 65535) {
                    console.log();
                    log('error', `Invalid port: ${c.bold}${next}${c.reset}`);
                    console.log();
                    process.exit(1);
                }
                i++;
                break;
            case '-h':
            case '--host':
                config.host = next;
                i++;
                break;
            case '-s':
            case '--secret':
                config.secret = next;
                i++;
                break;
            case '-d':
            case '--data':
                config.dataDir = next;
                i++;
                break;
            case '--kvm':
                config.enableKvm = true;
                break;
            case '--help':
                printHelp();
                process.exit(0);
            case '--version':
            case '-v':
                printVersion();
                process.exit(0);
        }
    }

    return config;
}

function printConfig(config) {
    console.log(`  ${c.bold}Configuration${c.reset}`);
    console.log(`  ${c.dim}─────────────────────────────${c.reset}`);
    console.log(`  ${c.dim}Host${c.reset}      ${c.cyan}${config.host}${c.reset}`);
    console.log(`  ${c.dim}Port${c.reset}      ${c.cyan}${config.port}${c.reset}`);
    console.log(`  ${c.dim}Data${c.reset}      ${c.cyan}${config.dataDir}${c.reset}`);
    console.log(`  ${c.dim}KVM${c.reset}       ${config.enableKvm ? `${c.green}enabled${c.reset}` : `${c.dim}disabled${c.reset}`}`);
    console.log();
}

const config = parseArgs(args);

if (!config.secret) {
    console.log();
    log('error', `Missing required option: ${c.cyan}--secret${c.reset}`);
    console.log();
    console.log(`  ${c.dim}Run${c.reset} npm run start:node -- --help ${c.dim}for usage${c.reset}`);
    console.log();
    process.exit(1);
}

printBanner();
printConfig(config);

log('info', 'Starting daemon...');

const daemon = new NodeDaemon(config);

process.on('SIGINT', () => {
    console.log();
    log('warn', 'Received SIGINT, shutting down...');
    daemon.shutdown();
    log('success', 'Daemon stopped');
    console.log();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('warn', 'Received SIGTERM, shutting down...');
    daemon.shutdown();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    log('error', `Uncaught exception: ${error.message}`);
    daemon.shutdown();
    process.exit(1);
});

try {
    daemon.start();
    log('success', `Listening on ${c.cyan}http://${config.host}:${config.port}${c.reset}`);
    console.log();
} catch (error) {
    log('error', `Failed to start: ${error.message}`);
    process.exit(1);
}
