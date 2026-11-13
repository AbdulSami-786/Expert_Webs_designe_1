// Stand-in for jsPDF's optional dependencies (html2canvas, dompurify).
//
// jsPDF imports both for its .html() renderer, which converts a DOM node into
// a PDF. The bill PDF is drawn with jsPDF's text API instead, so that renderer
// is never reached — but a bundler cannot prove it, so without this alias both
// libraries (~226KB) ship in a build that never executes a line of them.
//
// See the alias block in vite.config.js.
export default undefined;
