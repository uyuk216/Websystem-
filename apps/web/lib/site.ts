const TEMPLATE = process.env.NEXT_PUBLIC_SITE_URL_TEMPLATE ?? 'http://{name}.localhost:8090';

/** Public URL of a static site, from NEXT_PUBLIC_SITE_URL_TEMPLATE ("{name}" is replaced). */
export const siteUrl = (name: string): string => TEMPLATE.replace('{name}', name);
