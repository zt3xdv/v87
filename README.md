# V87 - Virtual Machine Hosting Panel

Virtual machine hosting panel using **QEMU** and **virt-builder**.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/zt3xdv/v87/main/setup.sh | bash
```

## Requirements

### System Dependencies

| Dependency | Description |
|------------|-------------|
| `qemu-system-x86_64` | Virtual machine emulator |
| `libguestfs-tools` | Includes virt-builder for creating images |
| `mkisofs` / `genisoimage` | For creating cloud-init ISOs |
| `curl` | For downloading resources |
| `Node.js >= 18` | Panel runtime |

### Installing Dependencies

**Debian/Ubuntu:**

```bash
sudo apt update
sudo apt install -y qemu-system-x86 libguestfs-tools genisoimage curl nodejs npm
```

**Fedora/RHEL:**

```bash
sudo dnf install -y qemu-kvm libguestfs-tools genisoimage curl nodejs npm
```

**Arch Linux:**

```bash
sudo pacman -S qemu-full libguestfs cdrtools curl nodejs npm
```

**openSUSE:**

```bash
sudo zypper install qemu libguestfs mkisofs curl nodejs npm
```

## Manual Installation

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
  "secretKey": "your-secure-secret-key",
  "limits": {
    "maxServers": 3,
    "maxRam": 4096,
    "maxDisk": 100
  },
  "vm": {
    "defaultImage": "fedora-40",
    "defaultRam": 1024,
    "defaultDisk": "10G",
    "cpuCores": 2,
    "qemuPath": "qemu-system-x86_64",
    "enableKvm": true
  }
}
```

## Available Images

Images are downloaded automatically via virt-builder:

- **Fedora**: fedora-40, fedora-39
- **Debian**: debian-12, debian-11
- **Ubuntu**: ubuntu-24.04, ubuntu-22.04
- **CentOS**: centos-stream-9
- **Rocky Linux**: rocky-9
- **AlmaLinux**: alma-9
- **Alpine**: alpine-3.19

List all available images:

```bash
virt-builder --list
```

## Usage

1. Access `http://localhost:3000`
2. Register an account (first user becomes admin)
3. Create a new VM by selecting a distribution
4. Start the VM and access the console

## Features

- Full virtual machines with QEMU/KVM
- Pre-configured images via virt-builder
- Complete isolation between VMs
- Real-time web console
- User system with roles (admin/user)
- Admin panel

## License

MIT
