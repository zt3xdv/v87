import Dialog from './modules/dialog.js';
import API from './modules/api.js';
import Theme from './modules/theme.js';
import Auth from './modules/auth.js';
import Dashboard from './modules/dashboard.js';
import Server from './modules/server.js';
import Admin from './modules/admin.js';
import Create from './modules/create.js';

window.Dialog = Dialog;

const App = window.App = {
    user: null,

    setUser(user) {
        this.user = user;
    },

    init: async () => {
        Theme.init();
        const token = localStorage.getItem('token');
        
        if (token) {
            try {
                const data = await API.get('/api/me');
                if (data.user) {
                    App.user = data.user;
                    if (['/login', '/register'].includes(location.pathname)) {
                        App.navigate('/dashboard');
                    } else {
                        App.router();
                    }
                } else {
                    localStorage.removeItem('token');
                    if (!['/login', '/register'].includes(location.pathname)) {
                        App.navigate('/login');
                    } else {
                        App.router();
                    }
                }
            } catch {
                localStorage.removeItem('token');
                App.navigate('/login');
            }
        } else {
            if (!['/login', '/register'].includes(location.pathname)) {
                App.navigate('/login');
            } else {
                App.router();
            }
        }

        window.addEventListener('popstate', App.router);
    },

    navigate(path) {
        history.pushState(null, '', path);
        App.router();
    },

    logout: async () => {
        await API.post('/api/logout', {});
        localStorage.removeItem('token');
        App.user = null;
        document.getElementById('nav-toggle').style.display = 'none';
        App.navigate('/login');
    },

    router() {
        const container = document.getElementById('app');
        const path = location.pathname === '/' ? '/dashboard' : location.pathname;

        Server.cleanupTerminal();
        Server.cleanupVnc();

        const serverMatch = path.match(/^\/server\/([^\/]+)(?:\/(console|creating|vnc|alerts))?$/);
        const adminMatch = path.match(/^\/admin(?:\/(servers|users|nodes|audit|maintenance|config))?$/);
        const accountMatch = path.match(/^\/account(?:\/(apikeys|webhooks|prefs|activity))?$/);

        if (path === '/dashboard') App.renderNav('dashboard');
        else if (path === '/create') App.renderNav('create');
        else if (adminMatch) App.renderNav('admin');
        else if (accountMatch) App.renderNav('account');
        else if (serverMatch) App.renderNav(serverMatch[2] || 'console', serverMatch[1]);
        else App.renderNav('none');

        if (path === '/login') {
            Auth.renderLogin(container, App.navigate.bind(App), App.setUser.bind(App));
        } else if (path === '/register') {
            Auth.renderRegister(container, App.navigate.bind(App), App.setUser.bind(App));
        } else if (path === '/dashboard') {
            if (!App.user) return App.navigate('/login');
            Dashboard.render(container, App.navigate.bind(App));
        } else if (path === '/create') {
            if (!App.user) return App.navigate('/login');
            Create.render(container, App.navigate.bind(App));
        } else if (adminMatch) {
            if (!App.user) return App.navigate('/login');
            if (App.user.role !== 'admin') return App.navigate('/dashboard');
            const tab = adminMatch[1] || 'servers';
            Admin.renderPanel(container, tab, App.navigate.bind(App));
        } else if (accountMatch) {
            if (!App.user) return App.navigate('/login');
            const tab = accountMatch[1] || 'apikeys';
            Auth.renderAccountPage(container, App.navigate.bind(App), App.user, tab, Theme.set.bind(Theme), Theme.get.bind(Theme));
        } else if (serverMatch) {
            if (!App.user) return App.navigate('/login');
            const serverId = serverMatch[1];
            const view = serverMatch[2] || 'console';
            if (view === 'creating') {
                Server.renderCreating(container, serverId, App.navigate.bind(App));
            } else {
                Server.renderPage(container, serverId, App.navigate.bind(App), App.user, view);
            }
        } else {
            if (App.user) App.navigate('/dashboard');
            else App.navigate('/login');
        }
    },

    renderNav(view, serverId = null) {
        const navToggle = document.getElementById('nav-toggle');
        const navMenu = document.getElementById('nav-menu');
        const navUser = document.getElementById('nav-user');

        if (!App.user) {
            navToggle.style.display = 'none';
            return;
        }

        navToggle.style.display = 'inline-flex';
        navUser.textContent = App.user.username;

        navToggle.onclick = (e) => {
            e.stopPropagation();
            navMenu.classList.toggle('hidden');
        };
        document.onclick = () => navMenu.classList.add('hidden');
        navMenu.onclick = (e) => e.stopPropagation();

        navMenu.innerHTML = '';

        const createItem = (label, path, isActive, icon) => {
            const a = document.createElement('div');
            a.className = `dropdown-item ${isActive ? 'active' : ''}`;
            a.innerHTML = `<span class="material-symbols-outlined" style="font-size:1.1rem; margin-right:8px; vertical-align:-3px;">${icon || 'circle'}</span> ${label}`;
            a.onclick = () => {
                navMenu.classList.add('hidden');
                App.navigate(path);
            };
            navMenu.appendChild(a);
        };

        const createHeader = (label) => {
            const h = document.createElement('div');
            h.className = 'dropdown-header';
            h.textContent = label;
            navMenu.appendChild(h);
        };

        const createDivider = () => {
            const d = document.createElement('div');
            d.className = 'dropdown-divider';
            navMenu.appendChild(d);
        };

        createItem('Dashboard', '/dashboard', view === 'dashboard', 'dashboard');
        createItem('Create VM', '/create', view === 'create', 'note_add');
        createItem('Account', '/account', view === 'account', 'account_circle');

        if (App.user.role === 'admin') {
            createItem('Admin', '/admin', view === 'admin', 'admin_panel_settings');
        }

        if (serverId) {
            createDivider();
            createHeader('VM Console');
            createItem('Console', `/server/${serverId}/console`, view === 'console', 'terminal');
            createItem('VNC', `/server/${serverId}/vnc`, view === 'vnc', 'desktop_windows');
            createItem('Alerts', `/server/${serverId}/alerts`, view === 'alerts', 'notifications');
        }

        createDivider();
        const logout = document.createElement('div');
        logout.className = 'dropdown-item';
        logout.innerHTML = `<span class="material-symbols-outlined" style="font-size:1.1rem; margin-right:8px; vertical-align:-3px;">logout</span> Logout`;
        logout.onclick = App.logout;
        navMenu.appendChild(logout);
    }
};

document.addEventListener('DOMContentLoaded', App.init);
