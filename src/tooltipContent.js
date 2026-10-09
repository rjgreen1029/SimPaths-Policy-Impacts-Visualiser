/* Render tooltip labels and values as text, preserving a bold heading and line breaks.
 */

export function setTooltipContent(element, { title, lines }) {
  const document = element.ownerDocument;
  const content = document.createDocumentFragment();
  const heading = document.createElement("strong");
  heading.textContent = title;
  content.append(heading);
  for (const line of lines.flatMap(line => typeof line === "string" ? line.split("\n") : [line])) {
    if (line == null || line === "") continue;
    content.append(document.createElement("br"), document.createTextNode(line));
  }
  element.replaceChildren(content);
}
