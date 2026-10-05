// Node has no window; plugin code uses window.setTimeout for popout compatibility.
(globalThis as { window?: unknown }).window ??= globalThis;
