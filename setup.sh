#!/bin/bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Symbols
CHECK="${GREEN}✓${NC}"
CROSS="${RED}✗${NC}"
ARROW="${CYAN}→${NC}"
WARN="${YELLOW}⚠${NC}"
INFO="${BLUE}●${NC}"

VERSION="1.0.0"
INSTALL_DIR="${V87_INSTALL_DIR:-$HOME/v87}"
REPO_URL="https://github.com/zt3xdv/v87.git"

log_info()    { echo -e "  ${INFO} $1"; }
log_success() { echo -e "  ${CHECK} $1"; }
log_warn()    { echo -e "  ${WARN} ${YELLOW}$1${NC}"; }
log_error()   { echo -e "  ${CROSS} ${RED}$1${NC}"; }
log_step()    { echo -e "\n${ARROW} ${BOLD}$1${NC}"; }

print_banner() {
    echo ""
    echo -e "  ${BOLD}${CYAN}V87${NC} ${DIM}Virtual Machine Management Platform${NC}"
    echo -e "  ${DIM}Version ${VERSION}${NC}"
    echo ""
    echo -e "  ${DIM}────────────────────────────────────${NC}"
    echo ""
}

print_section() {
    echo ""
    echo -e "  ${MAGENTA}┌─${NC} ${BOLD}$1${NC}"
    echo -e "  ${MAGENTA}│${NC}"
}

print_section_end() {
    echo -e "  ${MAGENTA}└─${NC} ${DIM}$1${NC}"
}

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

spinner() {
    local pid=$1
    local delay=0.1
    local spinstr='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    while ps -p $pid > /dev/null 2>&1; do
        local temp=${spinstr#?}
        printf "  ${CYAN}%c${NC} %s" "$spinstr" "$2"
        spinstr=$temp${spinstr%"$temp"}
        sleep $delay
        printf "\r\033[K"
    done
}

install_dependencies() {
    local pm=$(detect_package_manager)
    
    print_section "Installing Dependencies"
    log_info "Package manager: ${BOLD}$pm${NC}"
    echo -e "  ${MAGENTA}│${NC}"
    
    case $pm in
        apt)
            log_info "Installing with apt..."
            sudo apt update -qq
            sudo apt install -y -qq qemu-system-x86 libguestfs-tools genisoimage curl git > /dev/null 2>&1
            ;;
        dnf)
            log_info "Installing with dnf..."
            sudo dnf install -y -q qemu-kvm libguestfs-tools genisoimage curl git > /dev/null 2>&1
            ;;
        yum)
            log_info "Installing with yum..."
            sudo yum install -y -q qemu-kvm libguestfs-tools genisoimage curl git > /dev/null 2>&1
            ;;
        pacman)
            log_info "Installing with pacman..."
            sudo pacman -Sy --noconfirm --quiet qemu-full libguestfs cdrtools curl git > /dev/null 2>&1
            ;;
        zypper)
            log_info "Installing with zypper..."
            sudo zypper install -y -q qemu libguestfs mkisofs curl git > /dev/null 2>&1
            ;;
        termux)
            log_warn "Termux detected - QEMU not available natively"
            log_info "Installing available dependencies..."
            pkg install -y nodejs git curl > /dev/null 2>&1
            ;;
        *)
            log_warn "Unknown package manager"
            log_info "Please install manually:"
            echo -e "  ${MAGENTA}│${NC}   qemu-system-x86_64, libguestfs-tools"
            echo -e "  ${MAGENTA}│${NC}   mkisofs/genisoimage, curl, git"
            ;;
    esac
    
    print_section_end "Dependencies configured"
}

install_nodejs() {
    print_section "Node.js Setup"
    
    if check_command node; then
        local version=$(node --version)
        log_success "Node.js ${BOLD}$version${NC} already installed"
        print_section_end "Ready"
        return 0
    fi
    
    log_info "Installing Node.js..."
    
    local pm=$(detect_package_manager)
    
    case $pm in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
            sudo apt install -y -qq nodejs > /dev/null 2>&1
            ;;
        dnf|yum)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - > /dev/null 2>&1
            sudo dnf install -y -q nodejs > /dev/null 2>&1 || sudo yum install -y -q nodejs > /dev/null 2>&1
            ;;
        pacman)
            sudo pacman -Sy --noconfirm --quiet nodejs npm > /dev/null 2>&1
            ;;
        zypper)
            sudo zypper install -y -q nodejs npm > /dev/null 2>&1
            ;;
        termux)
            pkg install -y nodejs > /dev/null 2>&1
            ;;
        *)
            log_error "Could not install Node.js automatically"
            log_info "Please install Node.js >= 18 from https://nodejs.org/"
            exit 1
            ;;
    esac
    
    log_success "Node.js installed"
    print_section_end "Ready"
}

verify_dependencies() {
    print_section "Verifying Installation"
    
    local errors=0
    local warnings=0
    
    if check_command qemu-system-x86_64; then
        log_success "qemu-system-x86_64"
    else
        log_error "qemu-system-x86_64 not found"
        ((errors++)) || true
    fi
    
    if check_command virt-builder; then
        log_success "virt-builder (libguestfs)"
    else
        log_error "virt-builder not found"
        ((errors++)) || true
    fi
    
    if check_command mkisofs || check_command genisoimage; then
        log_success "mkisofs/genisoimage"
    else
        log_warn "mkisofs/genisoimage not found (optional)"
        ((warnings++)) || true
    fi
    
    if check_command node; then
        log_success "node ${DIM}$(node --version)${NC}"
    else
        log_error "Node.js not found"
        ((errors++)) || true
    fi
    
    if check_command npm; then
        log_success "npm ${DIM}$(npm --version)${NC}"
    else
        log_error "npm not found"
        ((errors++)) || true
    fi
    
    echo -e "  ${MAGENTA}│${NC}"
    if [[ $errors -eq 0 ]]; then
        print_section_end "All checks passed"
    else
        print_section_end "$errors errors, $warnings warnings"
    fi
    
    return $errors
}

clone_repository() {
    print_section "Repository Setup"
    
    if [[ -d "$INSTALL_DIR" ]]; then
        log_warn "Directory already exists: ${BOLD}$INSTALL_DIR${NC}"
        echo -e "  ${MAGENTA}│${NC}"
        echo -ne "  ${MAGENTA}│${NC}  ${BOLD}Overwrite?${NC} [y/N]: "
        read -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "$INSTALL_DIR"
        else
            log_info "Using existing directory"
            print_section_end "Skipped"
            return 0
        fi
    fi
    
    log_info "Cloning from GitHub..."
    git clone --quiet "$REPO_URL" "$INSTALL_DIR" > /dev/null 2>&1
    log_success "Cloned to ${BOLD}$INSTALL_DIR${NC}"
    print_section_end "Complete"
}

setup_project() {
    print_section "Project Configuration"
    
    cd "$INSTALL_DIR"
    
    log_info "Installing npm packages..."
    npm install --silent > /dev/null 2>&1
    log_success "Dependencies installed"
    
    if [[ ! -f "config.json" ]]; then
        cp config.example.json config.json
        log_success "config.json created"
    else
        log_info "config.json already exists"
    fi
    
    mkdir -p data/users data/images data/logs
    log_success "Data directories created"
    
    print_section_end "Complete"
}

print_success() {
    echo ""
    echo -e "  ${GREEN}╭──────────────────────────────────────╮${NC}"
    echo -e "  ${GREEN}│${NC}  ${CHECK} ${BOLD}Installation Complete${NC}              ${GREEN}│${NC}"
    echo -e "  ${GREEN}╰──────────────────────────────────────╯${NC}"
    echo ""
    echo -e "  ${BOLD}Next Steps:${NC}"
    echo ""
    echo -e "    ${DIM}1.${NC} cd ${CYAN}$INSTALL_DIR${NC}"
    echo -e "    ${DIM}2.${NC} Edit ${CYAN}config.json${NC} with your settings"
    echo -e "    ${DIM}3.${NC} Run ${CYAN}npm start${NC}"
    echo ""
    echo -e "  ${DIM}────────────────────────────────────${NC}"
    echo -e "  ${DIM}Access panel at${NC} ${CYAN}http://localhost:3000${NC}"
    echo ""
}

# Main
print_banner

echo -ne "  ${BOLD}Install system dependencies?${NC} [Y/n]: "
read -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    install_dependencies
fi

install_nodejs

if ! verify_dependencies; then
    log_warn "Some dependencies missing, continuing anyway..."
fi

clone_repository
setup_project
print_success
