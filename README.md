# V87 - Virtual Machine Hosting Panel

Virtual machine hosting panel using **QEMU** and **virt-builder**.

## Documentation

| Document | Description |
|----------|-------------|
| [Panel Setup](docs/panel.md) | Install and configure the web panel |
| [Node Setup](docs/node.md) | Install and configure VM nodes |

## Quick Start

```bash
# Panel only
git clone https://github.com/zt3xdv/v87.git
cd v87
npm install
cp config.example.json config.json
npm start
```

```bash
# Node installation
curl -fsSL https://raw.githubusercontent.com/zt3xdv/v87/main/setup.sh | bash
```

## Features

- Full virtual machines with QEMU/KVM
- Pre-configured images via virt-builder
- Complete isolation between VMs
- Real-time web console
- User system with roles (admin/user)
- Admin panel

## Available Images

Images are downloaded automatically via virt-builder:

- **Fedora**: fedora-40, fedora-39
- **Debian**: debian-12, debian-11, debian-13
- **Ubuntu**: ubuntu-24.04, ubuntu-22.04
- **CentOS**: centos-stream-9
- **Rocky Linux**: rocky-9
- **AlmaLinux**: alma-9
- **Alpine**: alpine-3.19

## License

MIT
