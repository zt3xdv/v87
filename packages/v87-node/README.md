# v87-node

Node daemon for V87 panel - runs QEMU VMs on remote servers.

## Installation

```bash
npm install -g v87-node
```

Or run from source:

```bash
cd packages/v87-node
npm install
npm start -- -p 7000 -s your-secret-key
```

## Usage

```bash
v87-node -p 7000 -s mysecretkey
v87-node --port 7000 --secret mysecret --kvm
v87-node -p 7000 -s secret -d /var/lib/v87
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port` | Port to listen on | 7000 |
| `-h, --host` | Host to bind to | 0.0.0.0 |
| `-s, --secret` | Secret key for auth (required) | - |
| `-d, --data` | Data directory | ./data |
| `--kvm` | Enable KVM acceleration | false |

## Protocol

The node communicates via WebSocket using JSON messages.

### Message Format

```json
{
  "type": "command-type",
  "id": "request-id",
  "payload": { ... }
}
```

### Authentication

First message must be `auth`:

```json
{
  "type": "auth",
  "id": "1",
  "payload": {
    "secret": "your-secret-key",
    "clientType": "panel"
  }
}
```

### Commands

#### Status

```json
{ "type": "status", "id": "2" }
```

Response:
```json
{
  "type": "status",
  "id": "2",
  "payload": {
    "nodeId": "abc123...",
    "version": 1,
    "uptime": 3600,
    "kvm": true,
    "vms": { "total": 5, "running": 3 },
    "images": 4
  }
}
```

#### Download Image

```json
{
  "type": "download-image",
  "id": "3",
  "payload": {
    "imageId": "debian-12",
    "url": "https://cloud.debian.org/images/...",
    "name": "Debian 12"
  }
}
```

Events during download:
- `download-progress`: `{ imageId, percent, downloadedBytes, totalBytes }`
- `download-complete`: `{ imageId }`
- `download-error`: `{ imageId, error }`

#### List Images

```json
{ "type": "list-images", "id": "4" }
```

#### Delete Image

```json
{
  "type": "delete-image",
  "id": "5",
  "payload": { "imageId": "debian-12" }
}
```

#### Create VM

```json
{
  "type": "create-vm",
  "id": "6",
  "payload": {
    "serverId": "srv-123",
    "userId": "user-456",
    "imageId": "debian-12",
    "ram": 2048,
    "disk": "20G",
    "cpuCores": 2
  }
}
```

Response includes generated password:
```json
{
  "type": "vm-created",
  "payload": {
    "serverId": "srv-123",
    "userId": "user-456",
    "password": "abc123xyz",
    "created": true
  }
}
```

#### Start VM

```json
{
  "type": "start-vm",
  "id": "7",
  "payload": {
    "serverId": "srv-123",
    "userId": "user-456"
  }
}
```

#### Stop VM

```json
{
  "type": "stop-vm",
  "id": "8",
  "payload": { "serverId": "srv-123" }
}
```

#### Delete VM

```json
{
  "type": "delete-vm",
  "id": "9",
  "payload": {
    "serverId": "srv-123",
    "userId": "user-456"
  }
}
```

#### VM Input (send to console)

```json
{
  "type": "vm-input",
  "payload": {
    "serverId": "srv-123",
    "data": "ls -la\n"
  }
}
```

#### VM Status

```json
{
  "type": "vm-status",
  "id": "10",
  "payload": { "serverId": "srv-123" }
}
```

#### VM Stats

```json
{
  "type": "vm-stats",
  "id": "11",
  "payload": { "serverId": "srv-123" }
}
```

#### List VMs

```json
{ "type": "list-vms", "id": "12" }
```

#### VNC Connect

```json
{
  "type": "vnc-connect",
  "id": "13",
  "payload": { "serverId": "srv-123" }
}
```

After connected, send VNC data:
```json
{
  "type": "vnc-data",
  "payload": { "data": "base64-encoded-vnc-data" }
}
```

### Events (node → panel)

These are sent without request ID:

- `vm-output`: `{ serverId, data }` - Console output
- `vm-status`: `{ serverId, status }` - Status change (running/stopped)
- `download-progress`: `{ imageId, percent, ... }`
- `download-complete`: `{ imageId }`
- `download-error`: `{ imageId, error }`
- `vnc-data`: `{ data }` - VNC data (base64)
- `vnc-disconnected`: VNC connection closed

## Data Directory Structure

```
data/
├── images/
│   ├── debian-12.qcow2
│   ├── debian-12.json
│   ├── ubuntu-24-04.qcow2
│   └── ubuntu-24-04.json
└── vms/
    └── user-456/
        └── srv-123/
            ├── disk.qcow2
            ├── metadata.json
            ├── cloud-init.iso
            └── cloud-init/
                ├── user-data
                └── meta-data
```

## Requirements

- Node.js >= 18
- QEMU (`qemu-system-x86_64`)
- `genisoimage` or `mkisofs` (for cloud-init)

## License

MIT
