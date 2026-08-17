const navLinks = [...document.querySelectorAll('.nav-link')]
const sections = navLinks
  .map(link => document.querySelector(link.getAttribute('href')))
  .filter(Boolean)

let navFrame

function updateNavigation() {
  let current = sections[0]
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= 150) current = section
  }
  navLinks.forEach(link => {
    link.classList.toggle('is-active', link.getAttribute('href') === `#${current.id}`)
  })
  navFrame = undefined
}

window.addEventListener('scroll', () => {
  if (navFrame !== undefined) return
  navFrame = requestAnimationFrame(updateNavigation)
}, { passive: true })
updateNavigation()

const live = new EventSource('/__live')
live.addEventListener('reload', () => window.location.reload())
