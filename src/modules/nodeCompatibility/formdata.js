export default `if (typeof globalThis.FormData === 'undefined') {
class FormData {
  constructor(form) {
    this._entries = [];
    
    // If initialized with another FormData, copy its entries
    if (form instanceof FormData) {
      form.forEach((value, key) => {
        this.append(key, value);
      });
    }
  }

  append(name, value, filename) {
    // Convert name to string
    name = String(name);
    
    // Handle Blob/File-like objects
    if (value && typeof value === 'object' && 'name' in value && 'size' in value) {
      // It's a File-like object
      const file = {
        name: filename || value.name || 'blob',
        size: value.size,
        type: value.type || '',
        _data: value._data || value
      };
      this._entries.push([name, file]);
    } else {
      // Convert to string for non-file values
      this._entries.push([name, String(value)]);
    }
  }

  delete(name) {
    name = String(name);
    this._entries = this._entries.filter(([key]) => key !== name);
  }

  get(name) {
    name = String(name);
    const entry = this._entries.find(([key]) => key === name);
    return entry ? entry[1] : null;
  }

  getAll(name) {
    name = String(name);
    return this._entries
      .filter(([key]) => key === name)
      .map(([, value]) => value);
  }

  has(name) {
    name = String(name);
    return this._entries.some(([key]) => key === name);
  }

  set(name, value, filename) {
    name = String(name);
    // Remove all existing entries with this name
    this.delete(name);
    // Add the new entry
    this.append(name, value, filename);
  }

  forEach(callback, thisArg) {
    for (const [name, value] of this._entries) {
      callback.call(thisArg, value, name, this);
    }
  }

  *entries() {
    for (const entry of this._entries) {
      yield entry;
    }
  }

  *keys() {
    for (const [key] of this._entries) {
      yield key;
    }
  }

  *values() {
    for (const [, value] of this._entries) {
      yield value;
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  // Helper method to get entries as array (useful for serialization)
  _getEntries() {
    return this._entries.slice();
  }
}
globalThis.FormData = FormData;
}
export default globalThis.FormData;
`
