const VALID_ID_REGEX = /^[A-Za-z0-9_-]+$/;

function isValidId(id) {
    return typeof id === 'string' && VALID_ID_REGEX.test(id) && id.length > 0 && id.length <= 64;
}

export { isValidId, VALID_ID_REGEX };
