# v87 Panel

A lightweight, single-process control panel for managing browser-based virtual machines using v86.

## Features

- **User Management**: Secure registration and login system.
- **Server Management**: Create, start, stop, and manage virtual servers (VMs).
- **Web Terminal**: Access your VM's console directly from the browser.
- **File Manager**: Upload, download, edit, and manage files within your VM's filesystem.
- **Resource Limits**: Configurable limits for RAM, storage, and number of servers per user.
- **Persistent Storage**: User data and server files are stored persistently.

## Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/zt3xdv/v87.git
    cd v87
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configuration:**
    *   Copy `config.example.json` to `config.json`:
        ```bash
        cp config.example.json config.json
        ```
    *   Edit `config.json` to set your secret key, port, and resource limits.

4.  **Prepare System Images:**
    *   Ensure you have a compatible ISO image (e.g., Alpine Linux) in `images/linux.iso` or update the path in your server creation logic/config.
    *   Ensure BIOS files are present in `bios/`.

## Usage

1.  **Start the panel:**
    ```bash
    npm start
    ```

2.  **Access the panel:**
    *   Open your browser and go to `http://localhost:3000` (or the port you configured).

3.  **Create an account:**
    *   Register a new user account.

4.  **Create a server:**
    *   Go to the dashboard and click "Create Server".
    *   Specify the RAM and Disk size (within your configured limits).

## Directory Structure

*   `panel/`: Source code for the control panel (server & frontend).
*   `data/`: Persistent data storage.
    *   `users.json`: User database.
    *   `servers.json`: Server database.
    *   `users_data/`: Root filesystems for user servers.
    *   `uploads/`: Temporary upload directory.
*   `images/`: ISO images for VMs.
*   `bios/`: BIOS binaries for v86.
*   `config.json`: Configuration file.

## Development

*   **Frontend**: The frontend is a vanilla JS SPA located in `panel/public`.
*   **Backend**: A Node.js Express server located in `panel/server.js`.
*   **VM Runner**: VMs are spawned as child processes using `panel/vm_runner.js`.

## License

M8T
