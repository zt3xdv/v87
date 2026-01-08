const Theme = {
    init() {
        const saved = localStorage.getItem('theme') || 'dark';
        this.set(saved);
    },

    set(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    },

    get() {
        return localStorage.getItem('theme') || 'dark';
    },

    toggle() {
        this.set(this.get() === 'dark' ? 'light' : 'dark');
    }
};

export default Theme;
