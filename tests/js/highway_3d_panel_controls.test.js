// Contract test for 3D Highway per-panel control metadata (feedBack#247).
// The plugin script is evaluated in a vm sandbox so factory statics are
// tested without constructing a renderer instance or calling init().

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');

// 'palette' was removed — per-string colors are now set via the core
// "Highway String Colors" UI, which drives both highways by named string.
const REQUIRED_KEYS = ['cameraZoom', 'cameraSmoothing', 'cameraLockLow', 'cameraLockZoom'];
const FORBIDDEN_KEYS = ['customImageDataUrl', 'customImageName', 'customVideoName'];
const VALID_TYPES = new Set(['select', 'range', 'toggle']);

function loadHighway3dStatics() {
    const src = fs.readFileSync(SCREEN_JS, 'utf8');
    // Inject test exports right after the factory registration — a stable,
    // semantic anchor inside the IIFE — so harmless footer edits (a trailing
    // sourceMappingURL comment, extra whitespace, a different IIFE close
    // style) do not break this contract test.
    const ANCHOR = 'window.feedBackViz_highway_3d = createFactory;';
    assert.equal(
        src.split(ANCHOR).length - 1,
        1,
        'expected exactly one factory-registration anchor in screen.js',
    );
    const instrumented = src.replace(
        ANCHOR,
        `${ANCHOR}\n    window.__h3dTestExports = { BG_DEFAULTS, camViewZoomMul, camBoundViewZoom, camLockZoomMul };`,
    );
    assert.notEqual(instrumented, src, 'test export injection anchor not found in screen.js');

    const sandbox = {
        console: {
            error() {},
            log() {},
            warn() {},
        },
        localStorage: {
            getItem() { return null; },
            setItem() {},
        },
        performance: { now: () => 0 },
        window: {
            feedBackTour: {
                register() {},
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(instrumented, sandbox, { filename: SCREEN_JS });
    return sandbox.window;
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function optionValue(option) {
    if (option && typeof option === 'object') return option.id;
    return undefined;
}

function assertOptionObject(option, controlKey) {
    assert.equal(
        Object.prototype.toString.call(option),
        '[object Object]',
        `${controlKey}.options entries must be { id, label } objects`,
    );
    assert.equal(typeof option.id, 'string', `${controlKey}.options id must be a string`);
    assert.ok(option.id.length > 0, `${controlKey}.options id must not be blank`);
    assert.equal(typeof option.label, 'string', `${controlKey}.options label must be a string`);
    assert.ok(option.label.trim().length > 0, `${controlKey}.options label must not be blank`);
}

test('3D Highway exposes static panelControls descriptors for per-panel hosts', () => {
    const window = loadHighway3dStatics();
    const factory = window.feedBackViz_highway_3d;
    assert.equal(typeof factory, 'function', 'screen.js must register the 3D Highway factory');

    assert.ok(
        Object.prototype.hasOwnProperty.call(factory, 'panelControls'),
        'panelControls must be an own static property on the factory',
    );
    assert.ok(Array.isArray(factory.panelControls), 'panelControls must be an array');

    const controls = cloneJson(factory.panelControls);
    const defaults = cloneJson(window.__h3dTestExports.BG_DEFAULTS);
    const keys = controls.map((control) => control && control.key);
    assert.deepEqual(keys, REQUIRED_KEYS, 'panelControls must expose exactly the issue #247 control set plus the general cameraZoom');
    const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);
    assert.deepEqual(duplicateKeys, [], 'panelControls keys must be unique');

    const controlsByKey = new Map();

    for (const control of controls) {
        assert.equal(
            Object.prototype.toString.call(control),
            '[object Object]',
            'each panel control must be a plain descriptor object',
        );
        assert.equal(typeof control.key, 'string', 'descriptor.key must be a string');
        assert.match(control.key, /^[A-Za-z][A-Za-z0-9]*$/, 'descriptor.key must be a BG_DEFAULTS-style key');
        assert.equal(typeof control.label, 'string', `${control.key}.label must be a string`);
        assert.ok(control.label.trim().length > 0, `${control.key}.label must not be blank`);
        assert.equal(typeof control.type, 'string', `${control.key}.type must be a string`);
        assert.ok(VALID_TYPES.has(control.type), `${control.key}.type must be select, range, or toggle`);
        assert.ok(Object.prototype.hasOwnProperty.call(control, 'default'), `${control.key} must declare a default`);
        assert.ok(
            Object.prototype.hasOwnProperty.call(defaults, control.key),
            `${control.key} must map to a BG_DEFAULTS entry`,
        );
        assert.deepEqual(control.default, defaults[control.key], `${control.key}.default must match BG_DEFAULTS`);
        assert.ok(!controlsByKey.has(control.key), `${control.key} appears more than once in panelControls`);
        controlsByKey.set(control.key, control);

        if (control.type === 'select') {
            assert.ok(Array.isArray(control.options), `${control.key}.options must be an array`);
            assert.ok(control.options.length > 0, `${control.key}.options must not be empty`);
            const values = control.options.map(optionValue);
            assert.equal(values.length, new Set(values).size, `${control.key}.options values must be unique`);
            for (const option of control.options) {
                assertOptionObject(option, control.key);
            }
            for (const value of values) {
                assert.equal(typeof value, 'string', `${control.key}.options values must be strings`);
            }
            assert.ok(values.includes(control.default), `${control.key}.options must include the default`);
        }

        if (control.type === 'range') {
            assert.equal(typeof control.min, 'number', `${control.key}.min must be a number`);
            assert.equal(typeof control.max, 'number', `${control.key}.max must be a number`);
            assert.ok(Number.isFinite(control.min), `${control.key}.min must be finite`);
            assert.ok(Number.isFinite(control.max), `${control.key}.max must be finite`);
            assert.ok(control.min < control.max, `${control.key}.min must be less than max`);
            assert.equal(typeof control.default, 'number', `${control.key}.default must be numeric`);
            assert.ok(control.default >= control.min, `${control.key}.default must be >= min`);
            assert.ok(control.default <= control.max, `${control.key}.default must be <= max`);
            if (Object.prototype.hasOwnProperty.call(control, 'step')) {
                assert.equal(typeof control.step, 'number', `${control.key}.step must be a number`);
                assert.ok(control.step > 0, `${control.key}.step must be positive`);
            }
        }

        if (control.type === 'toggle') {
            assert.equal(typeof control.default, 'boolean', `${control.key}.default must be boolean`);
        }
    }

    for (const key of REQUIRED_KEYS) {
        assert.ok(controlsByKey.has(key), `panelControls must include ${key}`);
    }
    for (const key of FORBIDDEN_KEYS) {
        assert.ok(!controlsByKey.has(key), `panelControls must not expose global-only asset key ${key}`);
    }

    const cameraSmoothing = controlsByKey.get('cameraSmoothing');
    assert.equal(cameraSmoothing.type, 'range', 'cameraSmoothing must be a range control');
    assert.equal(cameraSmoothing.min, 0);
    assert.equal(cameraSmoothing.max, 1);
    assert.equal(cameraSmoothing.default, defaults.cameraSmoothing);

    const cameraLockLow = controlsByKey.get('cameraLockLow');
    assert.equal(cameraLockLow.type, 'toggle', 'cameraLockLow must be a toggle control');
    assert.equal(typeof cameraLockLow.default, 'boolean', 'cameraLockLow default must be boolean');
    assert.equal(cameraLockLow.default, defaults.cameraLockLow);

    const cameraLockZoom = controlsByKey.get('cameraLockZoom');
    assert.equal(cameraLockZoom.type, 'range', 'cameraLockZoom must be a range control');
    assert.equal(cameraLockZoom.min, 0);
    assert.equal(cameraLockZoom.max, 1);
    assert.equal(cameraLockZoom.default, defaults.cameraLockZoom);
});

// ── cameraZoom: neutral default and bounded combination with Locked zoom ────

test('cameraZoom maps 0 / 0.5 / 1 to 0.7x / exactly 1.0x / 1.45x and is monotonic', () => {
    const { camViewZoomMul } = loadHighway3dStatics().__h3dTestExports;
    assert.equal(camViewZoomMul(0.5), 1, 'the default slider position must leave the framing unchanged');
    assert.equal(camViewZoomMul(0), 0.7);
    assert.equal(camViewZoomMul(1), 1.45);
    let prev = -Infinity;
    for (let z = 0; z <= 1.0001; z += 0.05) {
        const m = camViewZoomMul(z);
        assert.ok(m >= prev, `non-decreasing at ${z}`);
        prev = m;
    }
    assert.equal(camViewZoomMul(NaN), 1, 'a bad value falls back to neutral');
    assert.equal(camViewZoomMul(-3), 0.7);
    assert.equal(camViewZoomMul(9), 1.45);
});

test('cameraZoom default in BG_DEFAULTS is the neutral slider position', () => {
    const { BG_DEFAULTS, camViewZoomMul } = loadHighway3dStatics().__h3dTestExports;
    assert.equal(camViewZoomMul(BG_DEFAULTS.cameraZoom), 1);
});

test('with the lock engaged the two zooms cannot stack past either one\'s limits', () => {
    const { camViewZoomMul, camBoundViewZoom } = loadHighway3dStatics().__h3dTestExports;
    // float slack only; the products involved differ from their limits by far more
    const TOLERANCE = 1 / 1000000;
    const total = (lockMul, zoom) => lockMul * camBoundViewZoom(camViewZoomMul(zoom), lockMul);
    for (const lockMul of [0.55, 0.8, 1, 1.2, 1.45]) {
        for (const zoom of [0, 0.25, 0.5, 0.75, 1]) {
            const t = total(lockMul, zoom);
            assert.ok(t >= Math.min(lockMul, 0.7) - TOLERANCE, `lock ${lockMul} zoom ${zoom}: ${t} is closer than allowed`);
            assert.ok(t <= Math.max(lockMul, 1.45) + TOLERANCE, `lock ${lockMul} zoom ${zoom}: ${t} is further than allowed`);
        }
    }
    // the exact case the review flagged: both sliders at the near end
    assert.ok(total(0.55, 0) >= 0.55 - TOLERANCE, 'must not reach 0.55 * 0.7 = 0.385');
    // and both at the far end
    assert.ok(total(1.45, 1) <= 1.45 + TOLERANCE, 'must not reach 1.45 * 1.45 = 2.1');
    // without the lock (lockMul 1) the view zoom keeps its full range
    assert.equal(total(1, 0), 0.7);
    assert.equal(total(1, 1), 1.45);
});

test('Locked zoom has one multiplier mapping: neutral at 0.5 and used by every locked-camera site', () => {
    const { camLockZoomMul, BG_DEFAULTS } = loadHighway3dStatics().__h3dTestExports;
    assert.equal(camLockZoomMul(0.5), 1, 'default Locked zoom must keep the previous locked view');
    assert.equal(camLockZoomMul(0), 0.55);
    assert.equal(camLockZoomMul(1), 1.45);
    assert.equal(camLockZoomMul(BG_DEFAULTS.cameraLockZoom), 1);
    // The mapping lives in exactly one place. A second copy of the expression
    // would let the cameraZoom bound and the locked tgtDist drift apart.
    const src = fs.readFileSync(SCREEN_JS, 'utf8');
    const copies = src.match(/CAM_LOCK_ZOOM_MIN\s*\+/g) || [];
    assert.equal(copies.length, 1, 'only camLockZoomMul may compute CAM_LOCK_ZOOM_MIN + (...) * zoom');
    assert.ok((src.match(/camLockZoomMul\(cameraLockZoom\)/g) || []).length >= 4,
        'the three locked tgtDist sites and the cameraZoom bound must all call camLockZoomMul');
});
