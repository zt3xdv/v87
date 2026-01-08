const API = {
    token() {
        return localStorage.getItem('token');
    },

    headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token()}`
        };
    },

    async get(url) {
        const res = await fetch(url, { headers: this.headers() });
        return res.json();
    },

    async post(url, data) {
        const res = await fetch(url, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(data)
        });
        return res.json();
    },

    async put(url, data) {
        const res = await fetch(url, {
            method: 'PUT',
            headers: this.headers(),
            body: JSON.stringify(data)
        });
        return res.json();
    },

    async delete(url) {
        const res = await fetch(url, {
            method: 'DELETE',
            headers: this.headers()
        });
        return res.json();
    }
};

export default API;
