export function result(data, summary) {
  return { structuredContent: data, content: [{ type: "text", text: summary ?? JSON.stringify(data) }] };
}
