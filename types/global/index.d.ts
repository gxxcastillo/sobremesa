declare module '*.txt?raw' {
  const content: string;
  export default content;
}

declare module '*.txt' {
  const content: string;
  export default content;
}

declare module '*.md?raw' {
  const content: string;
  export default content;
}

declare module '*.md' {
  const content: string;
  export default content;
}
