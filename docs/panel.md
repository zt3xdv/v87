# Panel Setup

## Requirements

| Dependency | Description |
|------------|-------------|
| `curl` | For downloading resources |
| `Node.js >= 18` | Panel runtime |

## Installation

```bash
git clone https://github.com/zt3xdv/v87.git
cd v87
npm install
cp config.example.json config.json
npm start
```

## Configuration

Edit `config.json`:

```json
{
  "port": 3000,
  "secretKey": "v87-change-me-in-prod",
  "limits": {
    "maxServers": 1,
    "maxRam": 1024,
    "maxDisk": 5,
    "maxCpu": 100,
    "maxIo": 100,
    "minRam": 512,
    "minDisk": 5,
    "minCpu": 25
  },
  "vm": {
    "defaultImage": "debian-11",
    "defaultRam": 1024,
    "defaultDisk": "5G",
    "defaultCpu": 100,
    "defaultIo": 0,
    "cpuCores": 2,
    "qemuPath": "qemu-system-x86_64",
    "enableKvm": false,
    "timeout": 0
  }
}
```

## Usage

1. Access `http://localhost:3000`
2. Register an account (first user becomes admin)
3. Setup a node with a secret key
4. Create a new VM by selecting a distribution
5. Start the VM and access the console
