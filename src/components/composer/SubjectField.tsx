import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SubjectFieldProps = {
  subject: string;
  onSubjectChange: (value: string) => void;
};

export function SubjectField({ subject, onSubjectChange }: SubjectFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="email-subject">Subject</Label>
      <Input
        id="email-subject"
        value={subject}
        onChange={(event) => onSubjectChange(event.target.value)}
        placeholder="Email subject"
        maxLength={500}
      />
    </div>
  );
}
