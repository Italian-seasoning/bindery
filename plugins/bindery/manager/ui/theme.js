// Runs before first paint. Always sets data-theme to "light" or "dark" so CSS needs one selector per theme.
// Choice "system" follows the OS and updates live; "light" and "dark" are stored per browser.
(function () {
  var choice = 'system';
  try { choice = localStorage.getItem('ac-theme') || 'system'; } catch (e) {}
  var media = window.matchMedia('(prefers-color-scheme: light)');
  function apply() {
    var value = choice === 'light' || choice === 'dark' ? choice : (media.matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = value;
  }
  apply();
  media.addEventListener('change', function () { if (choice === 'system') apply(); });
  window.acTheme = {
    get: function () { return choice; },
    set: function (value) {
      choice = value === 'light' || value === 'dark' ? value : 'system';
      try {
        if (choice === 'system') localStorage.removeItem('ac-theme');
        else localStorage.setItem('ac-theme', choice);
      } catch (e) {}
      apply();
    },
  };
})();
