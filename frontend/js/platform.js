// Applied before styles load, so opening a page never swaps themes mid-frame.
(() => {
  const ios = /iPad|iPhone|iPod|GeneSenseiOS/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android|GeneSenseAndroid/.test(navigator.userAgent);
  document.documentElement.classList.toggle("platform-ios", ios);
  document.documentElement.classList.toggle("platform-android", android);
})();
