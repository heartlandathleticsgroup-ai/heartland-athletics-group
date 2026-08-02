const toggle = document.querySelector(".nav-toggle");
const navLinks = document.querySelector(".nav-links");

if (toggle && navLinks) {
  toggle.addEventListener("click", () => {
    const isOpen = navLinks.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });

  navLinks.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
}

const revealElements = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );

  revealElements.forEach((element) => observer.observe(element));
} else {
  revealElements.forEach((element) => element.classList.add("visible"));
}

const interestSelect = document.querySelector('select[name="interest"]');

document.querySelectorAll("[data-interest]").forEach((link) => {
  link.addEventListener("click", () => {
    const selectedInterest = link.dataset.interest;

    if (interestSelect && selectedInterest) {
      interestSelect.value = selectedInterest;
    }

    try {
      sessionStorage.setItem("hagInterest", selectedInterest);
    } catch (error) {
      // The site still works when browser storage is unavailable.
    }
  });
});

if (interestSelect) {
  const params = new URLSearchParams(window.location.search);
  const queryInterest = params.get("interest");

  let storedInterest = "";

  try {
    storedInterest = sessionStorage.getItem("hagInterest") || "";
  } catch (error) {
    storedInterest = "";
  }

  const requestedInterest = queryInterest || storedInterest;

  if (requestedInterest) {
    const matchingOption = Array.from(interestSelect.options).find(
      (option) =>
        option.value === requestedInterest ||
        option.text === requestedInterest
    );

    if (matchingOption) {
      interestSelect.value = matchingOption.value;

      try {
        sessionStorage.removeItem("hagInterest");
      } catch (error) {
        // No action is needed when browser storage is unavailable.
      }
    }
  }
}

const currentYear = document.querySelector("[data-current-year]");

if (currentYear) {
  currentYear.textContent = new Date().getFullYear();
}
