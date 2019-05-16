const { produce } = require('immer');
const TARGET_KEY = Symbol('target');
const WATCH_KEY = Symbol('watch');
const PREV_KEY = Symbol('prev');
const im = require('./util/im');

const MUTATIONS = ['produce', 'set', 'splice', 'del'];

class ImmutableModel {
    constructor(target) {
        this[PREV_KEY] = this[TARGET_KEY] = Object.assign({}, target || {});
        this[WATCH_KEY] = [];
        MUTATIONS.forEach((name) => {
            const mutation = this[name];
            this[name] = (...args) => {
                if (this._record() !== false) setImmediate(() => this._trigger());
                return mutation.apply(this, args);
            };
        });
    }

    produce(modifier) {
        this[TARGET_KEY] = produce(this[TARGET_KEY], modifier);
        return this;
    }

    set(...args) {
        args.unshift(this[TARGET_KEY]);
        this[TARGET_KEY] = im.set.apply(im, args);
        return this;
    }

    get(pathes) {
        return im.get(this[TARGET_KEY], pathes);
    }

    splice(...args) {
        args.unshift(this[TARGET_KEY]);
        this[TARGET_KEY] = im.splice.apply(im, args);
        return this;
    }

    del(pathes) {
        this[TARGET_KEY] = im.del(this[TARGET_KEY], pathes);
    }

    watch(pathes, callback) {
        if (typeof pathes === 'function') {
            callback = pathes;
            pathes = null;
        }
        const watcher = { callback, pathes };

        this[WATCH_KEY].push(watcher);

        return () => this.unwatch(watcher);
    }
    unwatch(watcher) {
        const watchers = this[WATCH_KEY];
        for (let idx = watchers.length; idx--; ) {
            if (watchers[idx] === watcher) {
                watchers.splice(idx, 1);
            }
        }
    }

    _record() {
        if (this._mark) return false;
        this._mark = this[TARGET_KEY];
    }

    _release() {
        const mark = this._mark;
        this._mark = null;
        return mark;
    }

    _trigger() {
        const mark = this._release();
        if (!mark) return false;
        const watchers = this[WATCH_KEY];
        watchers.forEach((watcher) => {
            if (!im.equal(mark, this[TARGET_KEY], watcher.pathes)) {
                if (typeof watcher.callback === 'function') {
                    watcher.callback(new WatchEvent(mark, this[TARGET_KEY], watcher.pathes));
                }
            }
        });
    }
}

class WatchEvent {
    constructor(prev, now, root) {
        this.affect = (pathes) => {
            if (root) {
                return !im.equal(im.get(prev, root), im.get(now, root), pathes);
            }
            return !im.equal(prev, now, pathes);
        };
    }
}

module.exports = ImmutableModel;
