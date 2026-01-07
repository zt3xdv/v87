#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         V87 Setup Script              ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
echo ""

INSTALL_DIR="${V87_INSTALL_DIR:-$HOME/v87}"
REPO_URL="https://github.com/zt3xdv/v87.git"

check_command() {
    command -v "$1" &> /dev/null
}

detect_package_manager() {
    if check_command apt; then
        echo "apt"
    elif check_command dnf; then
        echo "dnf"
    elif check_command yum; then
        echo "yum"
    elif check_command pacman; then
        echo "pacman"
    elif check_command zypper; then
        echo "zypper"
    elif check_command pkg && [[ -d "/data/data/com.termux" ]]; then
        echo "termux"
    else
        echo "unknown"
    fi
}

install_dependencies() {
    local pm=$(detect_package_manager)
    
    log_info "Detected package manager: $pm"
    
    case $pm in
        apt)
            log_info "Installing dependencies with apt..."
            sudo apt update
            sudo apt install -y qemu-system-x86 libguestfs-tools genisoimage curl git
            ;;
        dnf)
            log_info "Installing dependencies with dnf..."
            sudo dnf install -y qemu-kvm libguestfs-tools genisoimage curl git
            ;;
        yum)
            log_info "Installing dependencies with yum..."
            sudo yum install -y qemu-kvm libguestfs-tools genisoimage curl git
            ;;
        pacman)
            log_info "Installing dependencies with pacman..."
            sudo pacman -Sy --noconfirm qemu-full libguestfs cdrtools curl git
            ;;
        zypper)
            log_info "Installing dependencies with zypper..."
            sudo zypper install -y qemu libguestfs mkisofs curl git
            ;;
        termux)
            log_warn "Termux detected - QEMU not available natively"
            log_info "Installing available dependencies..."
            pkg install -y nodejs git curl
            ;;
        *)
            log_warn "Unknown package manager"
            log_info "Please install manually: qemu-system-x86_64, libguestfs-tools, mkisofs/genisoimage, curl, git"
            ;;
    esac
}

install_nodejs() {
    if check_command node; then
        local version=$(node --version)
        log_success "Node.js already installed: $version"
        return 0
    fi
    
    log_info "Installing Node.js..."
    
    local pm=$(detect_package_manager)
    
    case $pm in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt install -y nodejs
            ;;
        dnf|yum)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
            sudo dnf install -y nodejs || sudo yum install -y nodejs
            ;;
        pacman)
            sudo pacman -Sy --noconfirm nodejs npm
            ;;
        zypper)
            sudo zypper install -y nodejs npm
            ;;
        termux)
            pkg install -y nodejs
            ;;
        *)
            log_error "Could not install Node.js automatically"
            log_info "Please install Node.js >= 18 manually from https://nodejs.org/"
            exit 1
            ;;
    esac
}

verify_dependencies() {
    echo ""
    log_info "Verifying dependencies..."
    
    local errors=0
    
    if check_command qemu-system-x86_64; then
        log_success "qemu-system-x86_64"
    else
        log_error "qemu-system-x86_64 not found"
        ((errors++)) || true
    fi
    
    if check_command virt-builder; then
        log_success "virt-builder"
    else
        log_error "virt-builder not found (libguestfs-tools)"
        ((errors++)) || true
    fi
    
    if check_command mkisofs || check_command genisoimage; then
        log_success "mkisofs/genisoimage"
    else
        log_warn "mkisofs/genisoimage not found (optional for cloud-init)"
    fi
    
    if check_command node; then
        log_success "node $(node --version)"
    else
        log_error "Node.js not found"
        ((errors++)) || true
    fi
    
    if check_command npm; then
        log_success "npm $(npm --version)"
    else
        log_error "npm not found"
        ((errors++)) || true
    fi
    
    return $errors
}

clone_repository() {
    if [[ -d "$INSTALL_DIR" ]]; then
        log_warn "Directory $INSTALL_DIR already exists"
        read -p "Do you want to remove it and clone again? [y/N]: " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "$INSTALL_DIR"
        else
            log_info "Using existing directory..."
            return 0
        fi
    fi
    
    log_info "Cloning repository..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    log_success "Repository cloned to $INSTALL_DIR"
}

setup_project() {
    cd "$INSTALL_DIR"
    
    log_info "Installing npm dependencies..."
    npm install
    
    if [[ ! -f "config.json" ]]; then
        log_info "Creating config.json..."
        cp config.example.json config.json
        log_success "config.json created - edit it with your settings"
    fi
    
    mkdir -p data/users data/images data/logs
    log_success "Data directories created"
}

echo ""
read -p "Install system dependencies? [Y/n]: " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    install_dependencies
fi

install_nodejs

if ! verify_dependencies; then
    log_warn "Some dependencies are missing, but continuing..."
fi

echo ""
clone_repository
setup_project

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║      Installation complete!           ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}"
echo ""
echo "Next steps:"
echo "  1. cd $INSTALL_DIR"
echo "  2. nano config.json  # Edit configuration"
echo "  3. npm start"
echo ""
echo "Access: http://localhost:3000"
echo ""
