import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { useConductor } from '../conductor/conductorStore.js';
import { safeHttpsUrl } from '../conductor/format.js';
import {
  CC_BY_NC_LICENSE_URL,
  PIXEL_AGENTS_REPO_URL,
  PMD_SPRITE_REPO_URL,
  PMD_SPRITE_SITE_URL,
} from '../constants.js';
import { Modal } from './ui/Modal.js';

interface CreditsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline">
      {children}
    </a>
  );
}

/**
 * About and credits: what Poke Agents is (a visualizer for Conductor that
 * never runs agents itself), the Pixel Agents credit, the fan-project
 * disclaimer, the sprite source and license, and the artists of every
 * species in use (from pokemonSpeciesLoaded.credits).
 */
export function CreditsModal({ isOpen, onClose }: CreditsModalProps) {
  const speciesMap = useConductor((s) => s.species);
  const species = useMemo(
    () =>
      Object.values(speciesMap).sort((a, b) => a.dex - b.dex || Number(a.shiny) - Number(b.shiny)),
    [speciesMap],
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="About" className="w-[min(600px,100%)]">
      <div className="flex flex-col gap-10 px-10 pb-8 text-xs" style={{ lineHeight: 1.4 }}>
        <p className="m-0">
          Poke Agents shows your Conductor sessions as Pokémon in a pixel office. It is a visualizer
          for Conductor: all coding happens in Conductor, with your Conductor settings. Poke Agents
          never runs agents, never edits your repositories, and never stores or changes your
          Conductor settings. Sending a message, stopping a session, depositing it in the PC or
          withdrawing it only asks Conductor&apos;s API to do so.
        </p>
        <p className="m-0">
          The opt-in --claude mode is the one exception: it also tracks Claude Code on this computer
          and can start it in a local terminal.
        </p>
        <p className="m-0">
          Poke Agents is inspired by and built on{' '}
          <ExternalLink href={PIXEL_AGENTS_REPO_URL}>Pixel Agents</ExternalLink> by Pablo De Lucca,
          used under the MIT license.
        </p>
        <span className="text-sm text-accent">Credits</span>
        <p className="m-0">
          Poke Agents is a fan project and is not affiliated with, endorsed, sponsored or approved
          by Nintendo, The Pokémon Company, Creatures Inc., GAME FREAK inc. or Spike Chunsoft.
          Pokémon and Pokémon character names are trademarks of Nintendo, Creatures Inc. and GAME
          FREAK inc.
        </p>
        <p className="m-0">
          This repository contains no Pokémon artwork. When the Pokémon theme is on, the app
          downloads sprites and portraits from the PMD Sprite Repository (
          <ExternalLink href={PMD_SPRITE_SITE_URL}>sprites.pmdcollab.org</ExternalLink>,{' '}
          <ExternalLink href={PMD_SPRITE_REPO_URL}>PMDCollab/SpriteCollab</ExternalLink>) to a cache
          on your computer. Sprites credited to CHUNSOFT come from the Pokémon Mystery Dungeon
          games, © Nintendo, Creatures Inc., GAME FREAK inc. and Spike Chunsoft. Community sprites
          and portraits are © their credited artists and licensed under{' '}
          <ExternalLink href={CC_BY_NC_LICENSE_URL}>CC BY-NC 4.0</ExternalLink>. Use them only for
          non-commercial purposes. Each artist is listed below.
        </p>
        <p className="m-0">
          The Poke Agents source code is MIT-licensed, like Pixel Agents. The MIT license does not
          cover the downloaded artwork.
        </p>

        <section className="flex flex-col gap-6">
          <span className="text-sm text-accent">Pokémon in this office</span>
          {species.length === 0 ? (
            <span className="text-text-muted">No sprites loaded yet.</span>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-6">
              {species.map((s) => (
                <li key={`${s.dex}:${s.shiny ? 1 : 0}`} className="flex flex-col gap-2">
                  <span className="text-sm">
                    {s.name}
                    {s.shiny ? ' (shiny)' : ''}{' '}
                    {safeHttpsUrl(s.credits.pageUrl) ? (
                      <ExternalLink href={s.credits.pageUrl}>No. {s.dex}</ExternalLink>
                    ) : (
                      <span className="text-text-muted">No. {s.dex}</span>
                    )}
                  </span>
                  {s.credits.sprite.length > 0 && (
                    <span className="text-text-muted">Sprites: {s.credits.sprite.join(', ')}</span>
                  )}
                  {s.credits.portrait.length > 0 && (
                    <span className="text-text-muted">
                      Portraits: {s.credits.portrait.join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
