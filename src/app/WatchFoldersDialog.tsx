/** File › Watch folders: folders where new episodes arrive, each muxed with a
 *  recipe once it has stopped growing and the app is idle. Off until turned
 *  on; what is on comes back on at the next launch. */

import { AddRegular, DeleteRegular, PauseRegular, PlayRegular, StopRegular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";

import type { PipelineState } from "@/features/workspace/lib/watchPipeline";
import type { Recipe, WatchFolderConfig } from "@/shared/types/recipes";
import { Dialog } from "@/ui/frame";
import { Btn, Combo, InfoBar, Status, TBox, Toggle, cx, type St } from "@/ui/kit";
import { toast } from "@/ui/toast";

import { FolderField, SetRow, listText, textList } from "./fields";
import { newWatchFolder, watchProblem, type WatchFoldersState, type WatchStatus } from "./useWatchFolders";

const STATUS: Record<WatchStatus["state"], { s: St; text: string }> = {
  watching: { s: "ok", text: "Watching" },
  paused: { s: "wait", text: "Paused" },
  unavailable: { s: "warn", text: "Folder unavailable" },
  stopped: { s: "ready", text: "Off" },
  off: { s: "ready", text: "Off" },
};

const folderName = (path: string) => path.replace(/[\\/]+$/, "").replace(/^.*[\\/]/, "") || path;

export function watchStatusOf(state: WatchFoldersState, id: string): WatchStatus {
  return state.status[id] ?? { state: "off", error: null };
}

export function WatchFoldersDialog({
  watch,
  recipes,
  pipeline,
  onManageRecipes,
  onClose,
}: {
  watch: WatchFoldersState;
  recipes: Recipe[];
  pipeline: PipelineState;
  onManageRecipes: () => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(watch.folders[0]?.id ?? null);
  const [draft, setDraft] = useState<WatchFolderConfig | null>(watch.folders[0] ?? null);
  const saved = watch.folders.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null && watch.folders.length) {
      setSelectedId(watch.folders[0].id);
      setDraft(watch.folders[0]);
    }
  }, [watch.folders, selectedId]);

  const dirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(saved));
  const recipeIds = recipes.map((recipe) => recipe.id);
  const problem = draft ? watchProblem(draft, recipeIds) : null;
  const status = draft ? watchStatusOf(watch, draft.id) : null;
  const on = status ? status.state !== "off" && status.state !== "stopped" : false;
  const queued = draft ? pipeline.queue.filter((item) => item.watchId === draft.id).length : 0;
  const running = draft && pipeline.current?.watchId === draft.id ? pipeline.current : null;
  const set = (updates: Partial<WatchFolderConfig>) => draft && setDraft({ ...draft, ...updates });

  const report = (error: string | null, done?: string) => {
    if (error) toast({ title: "Watch folder", description: error, variant: "destructive" });
    else if (done) toast({ title: done });
  };

  const save = async () => {
    if (!draft) return;
    report(await watch.save(draft), `Saved the watch on ${folderName(draft.videoFolder) || "a folder"}`);
  };

  const select = (config: WatchFolderConfig) => {
    setSelectedId(config.id);
    setDraft(config);
  };

  return (
    <Dialog
      size="xl"
      title="Watch folders"
      sub="New episodes in a folder are loaded, paired, measured and muxed with a recipe, only while nothing else runs."
      onClose={onClose}
      left={
        draft && (
          <Btn
            icon={<DeleteRegular />}
            onClick={async () => {
              const error = saved ? await watch.remove(draft.id) : null;
              report(error);
              const next = watch.folders.find((item) => item.id !== draft.id) ?? null;
              setSelectedId(next?.id ?? null);
              setDraft(next);
            }}
          >
            Delete
          </Btn>
        )
      }
      foot={
        <>
          <Btn onClick={onClose}>Close</Btn>
          <Btn accent disabled={!draft || !dirty} onClick={() => void save()}>Save</Btn>
        </>
      }
      bodyClass="flush"
    >
      <div className="row" style={{ alignItems: "stretch", flex: 1, minHeight: 0 }}>
        <div className="col" style={{ width: 240, flexShrink: 0, borderRight: "1px solid var(--divider)", padding: 8, gap: 4 }}>
          <Btn
            icon={<AddRegular />}
            onClick={() => {
              const config = newWatchFolder();
              setSelectedId(config.id);
              setDraft(config);
            }}
          >
            Add a folder
          </Btn>
          {watch.error && <InfoBar tone="warn">{watch.error}</InfoBar>}
          <div className="col" role="listbox" aria-label="Watch folders" style={{ overflow: "auto", gap: 2, marginTop: 4 }}>
            {watch.folders.length === 0 && <div className="t3 sm" style={{ padding: 8 }}>None yet. Add the folder your new episodes land in.</div>}
            {watch.folders.map((config) => {
              const state = STATUS[watchStatusOf(watch, config.id).state];
              return (
                <button key={config.id} type="button" role="option" aria-selected={config.id === selectedId} className={cx("cmd", config.id === selectedId && "on")} style={{ justifyContent: "flex-start", width: "100%", height: 44, flexShrink: 0 }} onClick={() => select(config)}>
                  <span className="col" style={{ alignItems: "flex-start", minWidth: 0 }}>
                    <span className="truncate" style={{ maxWidth: 190 }}>{folderName(config.videoFolder) || "New folder"}</span>
                    <span className="sm t3">{state.text}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="grow" style={{ overflow: "auto", padding: "0 16px 16px" }}>
          {!draft ? (
            <div className="t3" style={{ padding: 24 }}>Add a folder to watch. Watching is off until you turn it on, and it never starts a mux during another batch or a measurement.</div>
          ) : (
            <>
              <div className="group-h">State</div>
              <div className="group">
                <SetRow
                  h={<Status s={STATUS[status!.state].s} text={status!.error ? `${STATUS[status!.state].text}: ${status!.error}` : STATUS[status!.state].text} />}
                  d={running ? running.detail || "Working on new episodes" : queued ? `${queued} new video${queued === 1 ? "" : "s"} waiting for the app to be idle` : on ? `Every ${draft.intervalSeconds} s; a file counts once its size holds for two looks.` : "Turn it on once the folders and the recipe are set."}
                >
                  <span className="row" style={{ gap: 4 }}>
                    {!on && (
                      <Btn icon={<PlayRegular />} disabled={Boolean(problem) || dirty || !saved} title={dirty || !saved ? "Save first" : (problem ?? undefined)} onClick={async () => report(await watch.start(draft.id), `Watching ${folderName(draft.videoFolder)}`)}>
                        Start
                      </Btn>
                    )}
                    {on && status!.state !== "paused" && <Btn icon={<PauseRegular />} onClick={() => void watch.setPaused(draft.id, true)}>Pause</Btn>}
                    {on && status!.state === "paused" && <Btn icon={<PlayRegular />} onClick={() => void watch.setPaused(draft.id, false)}>Resume</Btn>}
                    {on && <Btn icon={<StopRegular />} onClick={async () => report(await watch.stop(draft.id), `Stopped watching ${folderName(draft.videoFolder)}`)}>Stop</Btn>}
                  </span>
                </SetRow>
              </div>
              {problem && <InfoBar tone="info" style={{ marginTop: 12 }}>{problem}</InfoBar>}

              <div className="group-h">New episodes</div>
              <div className="group">
                <SetRow h="Video folder" d="Files already there when watching starts are left alone.">
                  <FolderField label="Video folder" value={draft.videoFolder} onChange={(videoFolder) => set({ videoFolder })} />
                </SetRow>
                <SetRow h="File types" d="Extensions, without the dot.">
                  <TBox label="Video file types" value={listText(draft.videoExtensions)} w={300} mono onChange={(text) => set({ videoExtensions: textList(text).map((ext) => ext.replace(/^\./, "").toLowerCase()) })} />
                </SetRow>
                <SetRow h="Include subfolders">
                  <Toggle on={draft.recursive} label name="Include subfolders" onChange={(recursive) => set({ recursive })} />
                </SetRow>
                <SetRow h="Look every" d="A network share is fine; a shorter interval only loads it more.">
                  <TBox
                    label="Seconds between looks"
                    value={String(draft.intervalSeconds)}
                    unit="s"
                    w={90}
                    mono
                    onChange={(text) => {
                      const value = Number(text);
                      if (Number.isFinite(value) && value > 0) set({ intervalSeconds: Math.min(3600, value) });
                    }}
                  />
                </SetRow>
              </div>

              <div className="group-h row" style={{ gap: 8 }}>
                <span className="grow">Recipe</span>
                <Btn onClick={onManageRecipes}>Recipes…</Btn>
              </div>
              <div className="group">
                <SetRow h="Mux with" d="Its track rules, slots, output name and folder, mux options and measuring.">
                  <Combo
                    label="Recipe"
                    value={draft.recipeId && recipeIds.includes(draft.recipeId) ? draft.recipeId : null}
                    placeholder={recipes.length ? "Choose a recipe" : "No recipes yet"}
                    w={300}
                    options={recipes.map((recipe) => ({ value: recipe.id, label: recipe.name }))}
                    onChange={(recipeId) => set({ recipeId })}
                  />
                </SetRow>
              </div>

              <div className="group-h">Where their files are</div>
              <div className="group">
                <SetRow h="Dubs" d="For the recipe's first audio slot; its other slots use their own folders.">
                  <FolderField label="Dub folder" value={draft.audioFolder} placeholder="The recipe's folder" onChange={(audioFolder) => set({ audioFolder })} />
                </SetRow>
                <SetRow h="Subtitles" d="For the recipe's first subtitle slot.">
                  <FolderField label="Subtitle folder" value={draft.subtitleFolder} placeholder="The recipe's folder" onChange={(subtitleFolder) => set({ subtitleFolder })} />
                </SetRow>
                <SetRow h="Chapters">
                  <FolderField label="Chapter folder" value={draft.chapterFolder} placeholder="None" onChange={(chapterFolder) => set({ chapterFolder })} />
                </SetRow>
              </div>
              <div className="t3 sm" style={{ marginTop: 12 }}>
                An episode whose dub or subtitle hasn't arrived yet, or whose measured delay needs a look, is loaded but not muxed: you'll find it in the queue.
              </div>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
