---
id: dbd6e66b-7508-54ff-b90f-651059051da3
title: How to enable WebGL
version: 2
---

# How to enable WebGL

Flowpad's graph views (World view, dependency graph) are drawn with **WebGL**.
If you see the message **"Graph view needs WebGL"**, your browser could not
create a WebGL context. This is almost always a browser setting — the steps
below fix it in a minute or two.

## Quick check

Open [get.webgl.org](https://get.webgl.org/) in a new tab. If you see a
spinning cube, WebGL works and you only need to reload Flowpad. If not, follow
the steps for your browser.

## Chrome

1. Open a new tab and go to `chrome://settings/system`.
2. Turn **on** "Use graphics acceleration when available".
3. Click **Relaunch** to restart Chrome.
4. Go to `chrome://gpu` and confirm **WebGL** and **WebGL2** say
   *Hardware accelerated*.

If `chrome://gpu` says *"Software only, hardware acceleration unavailable"*:

1. Go to `chrome://flags/#ignore-gpu-blocklist`.
2. Set **Override software rendering list** to **Enabled**.
3. Click **Relaunch**.

> **Tip:** Chrome also turns WebGL off temporarily after its GPU process
> crashes. If WebGL worked yesterday and is gone today, fully quit and reopen
> the browser before changing any settings.

## Edge

1. Open a new tab and go to `edge://settings/system`.
2. Turn **on** "Use graphics acceleration when available".
3. Restart Edge.
4. Go to `edge://gpu` and confirm WebGL says *Hardware accelerated*.

## Firefox

1. Open a new tab and go to `about:config`, then click
   **Accept the Risk and Continue**.
2. Search for `webgl.disabled` and make sure it is **false**
   (double-click it to toggle).
3. In **Settings → General → Performance**, keep
   "Use recommended performance settings" (or check
   "Use hardware acceleration when available").
4. Restart Firefox.

## Safari

WebGL is on by default in current Safari. If it is missing on an older
version (macOS):

1. Open **Safari → Settings → Advanced** and check
   **Show Develop menu in menu bar**.
2. In the menu bar choose **Develop → Experimental Features** and make sure
   **WebGL 2.0** is enabled.
3. Restart Safari.

## Still not working?

* Update your browser and your operating system — WebGL support rides on the
  graphics driver.

* On Windows, update the GPU driver from the vendor (NVIDIA/AMD/Intel), then
  restart.

* Remote desktops and virtual machines often have no GPU; enable 3D
  acceleration in the VM settings or use a local browser.

* After any change, reload Flowpad and reopen the graph view with its
  **Retry** button.
