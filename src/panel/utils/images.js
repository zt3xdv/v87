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
    'alpine-3-20': {
        id: 'alpine-3-20',
        name: 'Alpine Linux 3.20',
        description: 'Alpine Linux Virtual',
        url: 'https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/cloud/nocloud_alpine-3.20.3-x86_64-bios-cloudinit-r0.qcow2',
        defaultUser: 'root',
        defaultSize: '150M'
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
