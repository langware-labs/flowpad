import {
  flowMessageAttachmentDownloadUrl,
  localFlowMessageBundleUrl,
} from '@sdk/entities/flow-message';
import { describe, expect, it } from 'vitest';

describe('FlowMessage download URLs', () => {
  const messageId = 'f9ae3d56-fcec-4f60-b7cb-38f5b8a06ba6';

  it('uses the registered local bundle action', () => {
    expect(localFlowMessageBundleUrl(messageId)).toMatch(
      new RegExp(`/api/v1/graph/flow_message/${messageId}/create-and-download-local-flowmsg$`),
    );
  });

  it('routes embedded files through FlowMessage VFS storage', () => {
    expect(flowMessageAttachmentDownloadUrl(messageId, 'data/report.txt')).toMatch(
      new RegExp(`/api/v1/graph/flow_message/${messageId}/fs/download/data/report.txt$`),
    );
  });
});
