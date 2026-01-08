const rateLimitStore = new Map();

function rateLimit(key, maxAttempts, windowMs) {
    const now = Date.now();
    const record = rateLimitStore.get(key) || { attempts: 0, resetAt: now + windowMs };
    
    if (now > record.resetAt) {
        record.attempts = 0;
        record.resetAt = now + windowMs;
    }
    
    record.attempts++;
    rateLimitStore.set(key, record);
    
    return {
        allowed: record.attempts <= maxAttempts,
        remaining: Math.max(0, maxAttempts - record.attempts),
        resetAt: record.resetAt
    };
}

setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore) {
        if (now > record.resetAt + 60000) {
            rateLimitStore.delete(key);
        }
    }
}, 300000);

export { rateLimit };
