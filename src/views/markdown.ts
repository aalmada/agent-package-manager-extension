import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const markdown = new MarkdownIt({ html: false, linkify: true });
export function renderMarkdown(text: string, allowRemoteImages = false): { html: string; blockedImages: { https: boolean; insecure: boolean } } {
  const blockedImages = { https: false, insecure: false };
  const html = sanitizeHtml(markdown.render(text), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'details', 'summary']),
    allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'title'] },
    allowedSchemes: ['https', 'http', 'mailto'], allowProtocolRelative: false,
    transformTags: {
      img: (tagName, attributes) => {
        const source = attributes.src ?? '';
        const remote = /^\s*(?:https?:|[\\/]{2})/i.test(source);
        const insecure = /^\s*(?:http:|[\\/]{2})/i.test(source);
        if (remote && (!allowRemoteImages || insecure)) {
          if (insecure) blockedImages.insecure = true; else blockedImages.https = true;
          return { tagName: 'span', attribs: {}, text: attributes.alt ? `[Image blocked: ${attributes.alt}]` : '[Remote image blocked]' };
        }
        return { tagName, attribs: attributes };
      }
    }
  });
  return { html, blockedImages };
}
