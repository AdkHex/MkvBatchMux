import { useState, useEffect } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BaseModal } from "@/components/shared/BaseModal";

export interface VideoTrackInfo {
  videoId: string;
  videoName: string;
  found: boolean;
  isDefault: boolean;
  isForced: boolean;
  trackName: string;
  language: string;
}

interface TrackInfoEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trackInfo: VideoTrackInfo | null;
  onSave: (updated: VideoTrackInfo) => void;
  trackType: 'subtitle' | 'audio';
}

const languageOptions = [
  { value: 'eng', label: 'English' },
  { value: 'hin', label: 'Hindi' },
  { value: 'jpn', label: 'Japanese' },
  { value: 'chi', label: 'Chinese' },
  { value: 'ara', label: 'Arabic' },
  { value: 'fra', label: 'French' },
  { value: 'ger', label: 'German' },
  { value: 'spa', label: 'Spanish' },
  { value: 'kor', label: 'Korean' },
  { value: 'und', label: 'Undefined' },
];

export function TrackInfoEditDialog({
  open,
  onOpenChange,
  trackInfo,
  onSave,
  trackType,
}: TrackInfoEditDialogProps) {
  const [editedInfo, setEditedInfo] = useState<VideoTrackInfo | null>(null);

  useEffect(() => {
    if (trackInfo) {
      setEditedInfo({ ...trackInfo });
    }
  }, [trackInfo]);

  if (!editedInfo) return null;

  const handleSave = () => {
    onSave(editedInfo);
    onOpenChange(false);
  };

  return (
    <BaseModal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Track"
      subtitle={editedInfo.videoName}
      icon={<Pencil className="w-5 h-5 text-primary" />}
      className="max-w-md"
      footerRight={
        <>
          <Button
            variant="ghost"
            className="h-9 px-4 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button className="h-9 px-5 text-sm" onClick={handleSave}>
            Save Changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
            {trackType === 'subtitle' ? 'Subtitle' : 'Audio'} Track Name
          </label>
          <Input
            value={editedInfo.trackName}
            onChange={(e) => setEditedInfo({ ...editedInfo, trackName: e.target.value })}
            className="h-9"
            placeholder="Enter track name"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
            Language
          </label>
          <Select 
            value={editedInfo.language} 
            onValueChange={(value) => setEditedInfo({ ...editedInfo, language: value })}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {languageOptions.map((lang) => (
                <SelectItem key={lang.value} value={lang.value}>{lang.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-6 pt-1">
          <div className="flex items-center gap-2">
            <Checkbox 
              id="edit-default"
              checked={editedInfo.isDefault}
              onCheckedChange={(checked) => setEditedInfo({ ...editedInfo, isDefault: checked as boolean })}
            />
            <label htmlFor="edit-default" className="text-sm cursor-pointer">
              Set Default
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox 
              id="edit-forced"
              checked={editedInfo.isForced}
              onCheckedChange={(checked) => setEditedInfo({ ...editedInfo, isForced: checked as boolean })}
            />
            <label htmlFor="edit-forced" className="text-sm cursor-pointer">
              Set Forced
            </label>
          </div>
        </div>
      </div>
    </BaseModal>
  );
}
