export const VM_IMAGES = {
    'debian-13': {
        id: 'debian-13',
        name: 'Debian 13 (Trixie)',
        description: 'Debian 13 Generic Cloud',
        url: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2',
        defaultUser: 'root',
        defaultSize: '2G'
    },
    'debian-12': {
        id: 'debian-12',
        name: 'Debian 12 (Bookworm)',
        description: 'Debian 12 Generic Cloud',
        url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2',
        defaultUser: 'root',
        defaultSize: '2G'
    },
    'debian-11': {
        id: 'debian-11',
        name: 'Debian 11 (Bullseye)',
        description: 'Debian 11 Generic Cloud',
        url: 'https://cloud.debian.org/images/cloud/bullseye/latest/debian-11-generic-amd64.qcow2',
        defaultUser: 'root',
        defaultSize: '2G'
    },
    'ubuntu-24-04': {
        id: 'ubuntu-24-04',
        name: 'Ubuntu 24.04 LTS',
        description: 'Ubuntu Noble Numbat Cloud',
        url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',
        defaultUser: 'ubuntu',
        defaultSize: '2.5G'
    },
    'ubuntu-22-04': {
        id: 'ubuntu-22-04',
        name: 'Ubuntu 22.04 LTS',
        description: 'Ubuntu Jammy Jellyfish Cloud',
        url: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
        defaultUser: 'ubuntu',
        defaultSize: '2.5G'
    },
    'alpine-3-20': {
        id: 'alpine-3-20',
        name: 'Alpine Linux 3.20',
        description: 'Alpine Linux Virtual',
        url: 'https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/cloud/nocloud_alpine-3.20.3-x86_64-bios-cloudinit-r0.qcow2',
        defaultUser: 'root',
        defaultSize: '150M'
    },
    'fedora-40': {
        id: 'fedora-40',
        name: 'Fedora 40 Cloud',
        description: 'Fedora 40 Cloud Base',
        url: 'https://download.fedoraproject.org/pub/fedora/linux/releases/40/Cloud/x86_64/images/Fedora-Cloud-Base-Generic.x86_64-40-1.14.qcow2',
        defaultUser: 'fedora',
        defaultSize: '1G'
    },
    'rocky-9': {
        id: 'rocky-9',
        name: 'Rocky Linux 9',
        description: 'Rocky Linux 9 GenericCloud',
        url: 'https://download.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud-Base.latest.x86_64.qcow2',
        defaultUser: 'rocky',
        defaultSize: '1.5G'
    },
    'alma-9': {
        id: 'alma-9',
        name: 'AlmaLinux 9',
        description: 'AlmaLinux 9 GenericCloud',
        url: 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2',
        defaultUser: 'almalinux',
        defaultSize: '1.5G'
    }
};

export function getImage(imageId) {
    return VM_IMAGES[imageId] || null;
}

export function getImages() {
    return Object.values(VM_IMAGES);
}

export function getImageIds() {
    return Object.keys(VM_IMAGES);
}

export function imageExists(imageId) {
    return imageId in VM_IMAGES;
}
