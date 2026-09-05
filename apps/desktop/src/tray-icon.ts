/**
 * 托盘图标：32 × 32 的丘丘小像，直接内联成 data URL。
 *
 * 内联而不是放一个 png 文件，是为了让 `apps/desktop` 只产出 js，
 * 打包脚本不用额外搬资源。体色与眼色取自 `design/tokens.css` 的
 * `--qq-ball-body` `#F2E7D3` 与 `--qq-ball-eye` `#2A2621`。
 */

export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA2UlEQVR42t2XwRGDIBBFaYAicskhddgD' +
  'PWwP24PV0APnFJF7GtDNDGQcRhCUhU0O7+Kg/+kiLOr9eqqRqF8U0MREAIEe8Nc0p4AhLLEcYP3YZgKf' +
  'N3MFwTHO33tJAE8Ex+BZgblBeGCuFcCG4dkvkar5wsRUIuAYBdyRgGEMD5icgO0gYFMCukN4QO8JZCff' +
  '4377cmVMPBm3AlDy4FRAyZgNsCeAHQWwSoChBFhVAgagehJyrYiifsPhC5GIpXj4ZiRiOx7ekIhoyUQ0' +
  'pSLachEHEzFHs/88Ha943qPx4Td3VwAAAABJRU5ErkJggg==';
