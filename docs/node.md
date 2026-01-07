# Node Setup

## Requirements

| Dependency | Description |
|------------|-------------|
| `qemu-system-x86_64` | Virtual machine emulator |
| `libguestfs-tools` | Includes virt-builder for creating images |
| `mkisofs` / `genisoimage` | For creating cloud-init ISOs |
| `curl` | For downloading resources |
| `Node.js >= 18` | Panel runtime |

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/zt3xdv/v87/main/setup.sh | bash
```

## Installing Dependencies

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
npm run start:node -- -s <secret key> -p [port]
```

## Available Images

List all available images:

```bash
virt-builder --list
```
