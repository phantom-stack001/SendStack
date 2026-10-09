import { Copy, Eye, MoreHorizontal, Pencil, Trash2, XCircle } from "lucide-react";
import { Link } from "react-router-dom";

import { CampaignStatusBadge } from "@/components/campaigns/CampaignStatusBadge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Campaign } from "@/lib/campaigns-api";

function formatDate(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

function formatSchedule(campaign: Campaign) {
  if (!campaign.scheduledAt) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: campaign.scheduleTimezone || undefined,
    }).format(new Date(campaign.scheduledAt));
  } catch {
    return formatDate(campaign.scheduledAt);
  }
}

type CampaignsTableProps = {
  campaigns: Campaign[];
  onDuplicate: (campaign: Campaign) => void;
  onCancel: (campaign: Campaign) => void;
  onDelete: (campaign: Campaign) => void;
};

export function CampaignsTable({ campaigns, onDuplicate, onCancel, onDelete }: CampaignsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Eligible recipients</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead>Intended schedule</TableHead>
          <TableHead className="w-[80px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {campaigns.map((campaign) => (
          <TableRow key={campaign.id}>
            <TableCell className="font-medium">
              <Link className="hover:underline" to={`/app/campaigns/${campaign.id}/`}>
                {campaign.name || "Untitled campaign"}
              </Link>
            </TableCell>
            <TableCell>
              <CampaignStatusBadge status={campaign.status} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{campaign.eligibleRecipientCount}</TableCell>
            <TableCell>{formatDate(campaign.updatedAt)}</TableCell>
            <TableCell>{formatSchedule(campaign)}</TableCell>
            <TableCell>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Campaign actions">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link to={`/app/campaigns/${campaign.id}/`}>
                      <Eye className="size-4" />
                      View
                    </Link>
                  </DropdownMenuItem>
                  {campaign.status === "draft" && (
                    <DropdownMenuItem asChild>
                      <Link to={`/app/campaigns/${campaign.id}/edit/`}>
                        <Pencil className="size-4" />
                        Edit
                      </Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => onDuplicate(campaign)}>
                    <Copy className="size-4" />
                    Duplicate
                  </DropdownMenuItem>
                  {["draft", "ready", "scheduled", "queued", "processing", "paused"].includes(
                    campaign.status,
                  ) && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => onCancel(campaign)}>
                        <XCircle className="size-4" />
                        Cancel
                      </DropdownMenuItem>
                    </>
                  )}
                  {campaign.status === "draft" && (
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete(campaign)}>
                      <Trash2 className="size-4" />
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
