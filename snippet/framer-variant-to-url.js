(function () {
  try {
    var st = (performance.getEntriesByType("navigation")[0] || {}).serverTiming || [];
    var ab = "", route = "";
    for (var i = 0; i < st.length; i++) {
      if (st[i].name === "abtests") ab = st[i].description || "";
      if (st[i].name === "route") route = st[i].description || "";
    }
    if (!ab) return;
    var served = (route.match(/(?:^|&)id=([^&]+)/) || [])[1];
    if (!served) return;
    var assigned = ab.split("&").map(function (p) { return p.split("=")[1]; });
    if (assigned.indexOf(served) === -1) return;      // página não está em teste
    var u = new URL(location.href);
    if (u.searchParams.get("framer_variant") === served) return;
    u.searchParams.set("framer_variant", served);
    history.replaceState(history.state, "", u.toString());
  } catch (e) {}
})();
