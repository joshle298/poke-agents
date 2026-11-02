# Pokémon roster

The catalog contains **963 Pokémon** (up from 108), spanning all nine generations. Agents can use **915**: 852 regular species across 428 evolution lines and 63 legendary/mythical species selectable for Leads. The picker presents one tile per evolution line and searches every member by name or exact Pokédex number (for example, `Charizard` or `#006` finds Charmander’s line).

Automatic Leads still use the same eight defaults: Mewtwo, Mew, Zapdos, Suicune, Celebi, Jirachi, Darkrai and Arceus. Saved species and manual choices survive restarts. Regular Pokémon evolve at levels 16 and 36 along their own branch; Eevee and Ralts retain their original branch order and session hashes.

## Sources and coverage

- [PMD Sprite Repository tracker](https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/tracker.json): available normal sprites and portraits.
- [PokéAPI species metadata](https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species.csv): national dex numbers and evolution parents.
- [PokéAPI names](https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species_names.csv): English display names.

The initial normal-art audit passed for 963 species on November 1, 2026. Trubbish (#568) was excluded because its PNG failed decoding. The audit checks normal Idle and Walk animations, every frame and direction, a nonempty Normal portrait, and sprite/portrait credits. Shiny art is fetched on demand and has not been audited as part of this expansion.

Size is measured from the largest visible body extent across Idle/Walk frames: at most 32 pixels is small, at most 48 is medium, and larger is large. Large species and descendants reachable only through a large parent are excluded from assignment and the picker. The full catalog contains 685 small, 230 medium and 48 large species.

Existing size classifications are preserved for Charizard, Gastly, Vaporeon, Sylveon, Snorlax, Bayleef, Meganium, Feraligatr, Ampharos, Swampert, Monferno, Mewtwo and Mew. The verifier reports measured size without overwriting these compatibility choices.

Regional-form descendants whose required parent form is outside this normal-form roster start independent lines: Perrserker, Obstagoon, Cursola, Sirfetch’d, Mr. Rime, Runerigus, Overqwil, Sneasler, Clodsire and Basculegion.

## Updating and verifying

Edit `scripts/data/species.json`, then run:

```sh
npm run pokemon:generate
npm run pokemon:verify
```

The generator validates IDs, dex uniqueness, size classes, stage ordering and explicit evolution parents, then formats `server/src/pokemon/speciesCatalog.ts`. Lines with explicit parents must declare every evolution edge. Preserve the legacy Eevee and Ralts order when changing metadata.

The verifier writes `.context/pokemon-assets-report.json` and exits unsuccessfully if any species fails. It downloads and reuses assets in `~/.pixel-agents/cache/pmd`, outside the repository. Only metadata is committed; Pokémon artwork is never bundled. Each host, including the user’s Mac, downloads its own assets as needed. Verification in a cloud workspace does not preload another computer’s cache.

The app retains the PMD repository’s per-species credits under **Settings → About & credits**. See the README’s sprite licensing details before using the artwork.
