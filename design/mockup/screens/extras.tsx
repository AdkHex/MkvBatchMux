import {
  AddRegular,
  ArrowSyncRegular,
  AttachRegular,
  BookmarkMultipleRegular,
  ChevronDoubleDownRegular,
  ChevronDoubleUpRegular,
  ChevronDownRegular,
  ChevronUpRegular,
  DeleteRegular,
  DocumentRegular,
  FolderOpenRegular,
  ImageRegular,
  TextFontRegular,
} from "@fluentui/react-icons";

import { CHAP_DIR, CHAPTERS, FONT_DIR, FONTS, VIDEOS } from "../data";
import { Btn, Cmd, Combo, DL, Empty, Fld, MidText, Table, TBox, TRow, Toggle, Tr } from "../kit";
import { Box, Window, useProto } from "../shell";
import { L, Links, QueueBtn, SearchBox } from "./common";

/* =============================== CHAPTERS =============================== */

export function Chapters({ on }: { on: boolean }) {
  const { go } = useProto();
  const sel = on ? 3 : null;
  return (
    <Window
      page="chapters"
      lcd={on ? { l1: "16 chapter files · 16 linked", l2: "1 linked by hand · old chapters kept" } : { l1: "Chapters are off", l2: "The videos keep the chapters they have" }}
      tools={
        <>
          <Cmd icon={<FolderOpenRegular />} disabled={!on}>Choose folder</Cmd>
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!on} />
          <Cmd icon={<ChevronDoubleUpRegular />} title="Move to the top" disabled={!on} />
          <Cmd icon={<ChevronUpRegular />} title="Move up (Alt+↑)" disabled={!on} />
          <Cmd icon={<ChevronDownRegular />} title="Move down (Alt+↓)" disabled={!on} />
          <Cmd icon={<ChevronDoubleDownRegular />} title="Move to the bottom" disabled={!on} />
        </>
      }
      primary={<QueueBtn />}
    >
      {on ? (
        <Box
          body={false}
          title="Chapters"
          sub={<span title={CHAP_DIR}>{CHAP_DIR}</span>}
          end={
            <>
              <Combo ghost sm value="All formats" w={104} />
              <SearchBox w={150} />
            </>
          }
        >
          <Table cols="24px minmax(0,1fr) minmax(0,1fr) 72px 88px" head={["#", "Chapter file", "Video", " Delay", "Linked"]}>
            {CHAPTERS.map((c, i) => (
              <Tr key={c.name} on={i === sel}>
                <span className="num t3">{i + 1}</span>
                <span className="cell"><span className="fi"><DocumentRegular /></span><span className="truncate">{c.name}</span></span>
                <span className="pairdub" style={{ minWidth: 0 }}><Combo ghost sm value={VIDEOS[i === 3 ? 4 : i].name} w="100%" /></span>
                <span className="r num t2" style={{ display: "flex" }}>{i === 3 ? "+0.500" : "0.000"}</span>
                <span className={i === 3 ? "" : "t3"}>{i === 3 ? "By hand" : "By order"}</span>
              </Tr>
            ))}
          </Table>
        </Box>
      ) : (
        <section className="box">
          <Empty icon={<BookmarkMultipleRegular />} title="Chapters are off">
            <Btn onClick={() => go("chapters-ready")}>Turn on chapters</Btn>
          </Empty>
        </section>
      )}
      <div className="stack">
        <Box title="Chapters">
          <TRow label="Add chapters from files"><Toggle on={on} /></TRow>
          <Fld label="Delay for every file">
            <div className="row" style={{ gap: 8 }}>
              <span className="grow"><TBox value="0.000" unit="s" mono /></span>
              <Btn disabled={!on}>Apply to all</Btn>
            </div>
          </Fld>
          <TRow label="Discard the videos' own chapters"><Toggle on={false} /></TRow>
        </Box>
        {on && sel !== null && (
          <Box title={<MidText text={CHAPTERS[sel].name} tail={20} />}>
            <DL rows={[["Video", <MidText key="v" text={VIDEOS[4].name} tail={20} />], ["Linked", "By hand"], ["Size", CHAPTERS[sel].size]]} />
            <Fld label="Delay"><TBox value="+0.500" unit="s" mono /></Fld>
            <Links>
              <L icon={<ArrowSyncRegular />}>Link by order again</L>
            </Links>
          </Box>
        )}
      </div>
    </Window>
  );
}

/* ============================== ATTACHMENTS ============================== */

export function Attachments({ on }: { on: boolean }) {
  const { go } = useProto();
  const sel = on ? 0 : null;
  return (
    <Window
      page="attachments"
      lcd={on ? { l1: "4 attachments · 8.5 MB", l2: "Added to every queued video" } : { l1: "Attachments are off", l2: "The videos keep the attachments they have" }}
      tools={
        <>
          <Cmd icon={<AddRegular />} disabled={!on}>Add files</Cmd>
          <Cmd icon={<FolderOpenRegular />} title="Choose folder" disabled={!on} />
          <Cmd icon={<ArrowSyncRegular />} title="Rescan" disabled={!on} />
          <Cmd icon={<DeleteRegular />} title="Remove (Del)" disabled={sel === null} />
        </>
      }
      primary={<QueueBtn />}
    >
      {on ? (
        <Box
          body={false}
          title="Attachments"
          sub={<span title={FONT_DIR}>{FONT_DIR}</span>}
          end={
            <>
              <Combo ghost sm value="All formats" w={104} />
              <Combo ghost sm value="Loaded order" w={116} />
              <SearchBox w={150} />
            </>
          }
        >
          <Table cols="24px minmax(0,1fr) 72px 80px" head={["#", "Name", "Type", " Size"]}>
            {FONTS.map((f, i) => (
              <Tr key={f.name} on={i === sel}>
                <span className="num t3">{i + 1}</span>
                <span className="cell"><span className="fi">{f.type === "JPG" ? <ImageRegular /> : <TextFontRegular />}</span><MidText text={f.name} /></span>
                <span className="t2">{f.type}</span>
                <span className="r num t2" style={{ display: "flex" }}>{f.size}</span>
              </Tr>
            ))}
          </Table>
        </Box>
      ) : (
        <section className="box">
          <Empty icon={<AttachRegular />} title="Attachments are off">
            <Btn onClick={() => go("attach-ready")}>Turn on attachments</Btn>
          </Empty>
        </section>
      )}
      <div className="stack">
        <Box title="Attachments">
          <TRow label="Add attachments" d="To every queued video"><Toggle on={on} /></TRow>
          <TRow label="Discard the videos' own attachments"><Toggle on={false} /></TRow>
          <TRow label="Allow duplicate names"><Toggle on={false} /></TRow>
          <TRow label="Expert mode"><Toggle on={false} /></TRow>
        </Box>
        {on && sel !== null && (
          <Box title={<MidText text={FONTS[sel].name} tail={20} />}>
            <DL rows={[["Type", "OpenType font"], ["Size", FONTS[sel].size], ["Folder", <span key="f" className="truncate" title={FONT_DIR}>{FONT_DIR}</span>]]} />
            <Links>
              <L icon={<DeleteRegular />}>Remove</L>
            </Links>
          </Box>
        )}
      </div>
    </Window>
  );
}
