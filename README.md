# Shopify clothing sections (Horizon theme)

Two sections for Shopify's Horizon theme that hang products on a rail like clothes in a shop.

## Clothing rack
Garments hang packed on a straight chrome rail.
- **Pulling hangers:** you pull the hangers left and right; they push each other, slide on with momentum, and swing on their hooks.
- **Hover:** turns a garment to its second image.
- **Click:** lifts it off the rack into a centred detail view over a blurred page, with colour tags (switch the image), size pills, Add to cart (updates Horizon's cart drawer) and a link to the product.

Files: `sections/clothing-rack.liquid`, `assets/clothing-rack.js`, `snippets/clothing-rail-hook.liquid`

## Clothing rail
Garments hang on a curved chrome rail you swipe or drag through.
- The garment in the centre comes forward, with its title and price under the rail, a progress bar, and a link to the collection.
- Hover turns a garment to its second image.

Files: `sections/clothing-rail.liquid`, `assets/clothing-rail.js`, `snippets/clothing-rail-hook.liquid`

## Install
- **Shopify CLI:** copy the folders into your theme, then run `shopify theme push --only sections/clothing-ra* --only assets/clothing-ra* --only snippets/clothing-rail-hook.liquid`
- **Shopify admin:** go to **Online Store → Themes → … → Edit code** and create each file with the same name and contents:
  - sections: `clothing-rack`, `clothing-rail`
  - assets: `clothing-rack.js`, `clothing-rail.js`
  - snippet: `clothing-rail-hook`

Then in the theme editor: **Add section → Clothing rack** or **Clothing rail**.

## Requirements
- A Horizon-based theme. The scripts use Horizon's import map (`@theme/utilities`, `@shopify/events`), and the sections use its `spacing-style` and `contrast-override` snippets.
- Optional product metafield `custom.rail_image` (file → image) for a cut-out photo per product. Both sections use it before the product's own images.

## Settings worth knowing
- **Trim photo top:** pulls the photo up so the hanger meets the collar.
- **Garment size / Garment spacing:** how big the garments are and how tightly they pack.
- **Remove plain photo backgrounds** (rack) / **Blend white photo backgrounds** (rail).
- **Turn to second image on hover.**
