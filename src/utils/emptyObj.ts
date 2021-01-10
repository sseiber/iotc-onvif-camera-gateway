export function emptyObj(object: any): boolean {
    if (!object) {
        return false;
    }

    for (const key in object) {
        if (Object.prototype.hasOwnProperty.call(object, key)) {
            return false;
        }
    }

    return true;
}
