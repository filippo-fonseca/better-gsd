export default function BuggyPage() {
  // Intentional defect (Phase 5 make-or-break): a <div> nested directly inside a
  // <p> triggers React's `validateDOMNesting` console error in dev mode. The page
  // still renders its text normally, so a screenshot looks completely fine — the
  // only evidence of the bug lives in the browser console. This is exactly the
  // class of defect bgsd must catch that a vision/screenshot pass would miss.
  return (
    <main>
      <h1>bgsd canary-next</h1>
      <p>
        Isolation fixture — Phase 2 runtime-isolate test target.
        <div>This div is illegally nested inside a paragraph.</div>
      </p>
    </main>
  )
}
