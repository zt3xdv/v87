import crypto from 'node:crypto';

export const WEBHOOK_EVENTS = ['vm_start', 'vm_stop', 'vm_create', 'vm_delete', 'alert_triggered'];

function log(message) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`  \x1b[2m${timestamp}\x1b[0m  \x1b[34m●\x1b[0m  ${message}`);
}

export async function triggerWebhooks(db, event, data) {
    const webhooks = db.getWebhooksByEvent(event);
    
    for (const webhook of webhooks) {
        const payload = {
            event,
            timestamp: new Date().toISOString(),
            data
        };
        
        const headers = {
            'Content-Type': 'application/json',
            'X-Webhook-Event': event,
            'X-Webhook-Timestamp': payload.timestamp,
            'User-Agent': 'v87-webhook/1.0'
        };
        
        if (webhook.secret) {
            const signature = crypto
                .createHmac('sha256', webhook.secret)
                .update(JSON.stringify(payload))
                .digest('hex');
            headers['X-Webhook-Signature'] = `sha256=${signature}`;
        }
        
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            
            const response = await fetch(webhook.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            
            if (response.ok) {
                log(`Webhook ${webhook.id} delivered: ${event} -> ${webhook.url}`);
            } else {
                log(`Webhook ${webhook.id} failed: ${response.status} ${response.statusText}`);
            }
        } catch (err) {
            log(`Webhook ${webhook.id} error: ${err.message}`);
        }
    }
}

export async function testWebhook(webhook) {
    const payload = {
        event: 'test',
        timestamp: new Date().toISOString(),
        data: { message: 'This is a test webhook from v87' }
    };
    
    const headers = {
        'Content-Type': 'application/json',
        'X-Webhook-Event': 'test',
        'X-Webhook-Timestamp': payload.timestamp,
        'User-Agent': 'v87-webhook/1.0'
    };
    
    if (webhook.secret) {
        const signature = crypto
            .createHmac('sha256', webhook.secret)
            .update(JSON.stringify(payload))
            .digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
        const response = await fetch(webhook.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        return {
            success: response.ok,
            status: response.status,
            statusText: response.statusText
        };
    } catch (err) {
        clearTimeout(timeout);
        return {
            success: false,
            error: err.message
        };
    }
}

export function createWebhookHelper(db) {
    return (event, data) => triggerWebhooks(db, event, data);
}
