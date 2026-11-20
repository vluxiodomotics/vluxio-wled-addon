# Vluxio WLED Add-on

![Vluxio logo](assets/vluxio-domotics.png)

**An independent add-on for WLED.** This add-on connects WLED lighting to ABB free@home. It is an independent Vluxio project and is not an official ABB or Busch-Jaeger product.

## Version 1.6.1 beta

This is the first public test version. It provides a main dimmer, WLED segment switches, selected preset actors and optional next/previous preset actors. You can configure additional controllers using **Add controller** in the add-on settings. The current beta accepts up to four configured controllers; this is a provisional limit pending SysAP load measurements.

The add-on creates devices only for configured controllers. It reads WLED segment IDs at startup and after successful full state reads, adding new segments and removing ones no longer present. A connection failure does not delete segment devices.

## Real-world testing

The Vluxio WLED Add-on has been running in daily use on an ABB-free@home System Access Point 2 (SysAP 2) for approximately four months. During this period, issues identified through regular use were corrected and retested. No known operational issues remain in the existing installation.

Version 1.6.1 builds on this extensively tested implementation and introduces configuration changes to make the add-on suitable for use in other installations. These changes have passed automated validation but have not yet been independently verified through a fresh installation.

## Requirements and installation

- ABB free@home System Access Point 2.0 with firmware 3.0 or newer and the Local API enabled.
- One or more WLED controllers reachable from the SysAP on the local network.
- A SysAP backup before installing or updating this beta.

Download the `local.vluxio.freeathome-wled-1.6.1.tar` asset from the GitHub release and upload it under **Installation settings → Add-ons** in free@home. Enter the current IP address of controller 1. Add other controllers only when needed. After saving, place the new virtual devices in the intended free@home room using **Devices, scenes and groups → Position** before linking them to switches or scenes.

Only the preset numbers entered in the **Selectable preset IDs** field are available for switch navigation. A blank field allows all named WLED presets. Press and hold the main switch to dim; optional preset actors or the configured multiple-press action select presets.

## Beta test status

The TypeScript build, ABB metadata validation, NL/DE/EN settings translations and 28 automated tests passed. The Add controller and remove controls have appeared on one SysAP. Real-device checks are still needed for a second controller, controller removal, segment changes, existing links and scenes, reconnects, and CPU/RAM use. Please report the SysAP firmware, WLED version, the relevant log message and reproduction steps when filing an issue; do not post passwords or private network details.


## License

MIT. See [LICENSE](LICENSE).
