import { NodeDaemon } from './daemon.js';

const args = process.argv.slice(2);

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
        }
    }

    return config;
}

function printHelp() {
    console.log(`
V87 Node Daemon

Usage: npm run start:node -- [options]

Options:
  -p, --port <port>     Port to listen on (default: 7000)
  -h, --host <host>     Host to bind to (default: 0.0.0.0)
  -s, --secret <key>    Secret key for panel authentication (required)
  -d, --data <dir>      Data directory for VMs (default: ./data)
  --kvm                 Enable KVM acceleration
  --help                Show this help message
  --version             Show version

Examples:
  npm run start:node -- -p 7000 -s mysecretkey
  npm run start:node -- --port 7000 --secret mysecret --kvm
  npm run start:node -- -p 7000 -s secret -d /var/lib/v87
`);
}

const config = parseArgs(args);

if (!config.secret) {
    console.error('Error: --secret is required');
    console.error('Run npm run start:node -- --help for usage');
    process.exit(1);
}

const daemon = new NodeDaemon(config);

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    daemon.shutdown();
    process.exit(0);
});

process.on('SIGTERM', () => {
    daemon.shutdown();
    process.exit(0);
});

daemon.start();
