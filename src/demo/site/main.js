// Kopi Senja: mobile nav, menu tabs, reservation form.
(function () {
  var toggle = document.querySelector(".menu-toggle");
  var nav = document.getElementById("nav");
  toggle.addEventListener("click", function () {
    var open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  nav.addEventListener("click", function (e) {
    if (e.target.tagName === "A") { nav.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }
  });

  var tabs = document.querySelectorAll("[data-tab]");
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t === tab)); });
      document.querySelectorAll("[data-panel]").forEach(function (p) {
        p.hidden = p.getAttribute("data-panel") !== tab.getAttribute("data-tab");
      });
    });
  });

  var form = document.getElementById("reserve");
  var note = document.getElementById("reserve-note");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = form.elements.name.value.trim();
    var time = form.elements.time.value;
    note.textContent = "Thanks " + name + ", a window seat is yours at " + time + ". See you at golden hour.";
    form.reset();
  });

  document.getElementById("year").textContent = String(new Date().getFullYear());
})();
