/** Kernel media reference capabilities exposed to trusted plugins. */
export interface MediaReferenceService {
  register(input: {
    attachmentId: string;
    resourceType: string;
    resourceId: string;
    field?: string;
    /** Kernel-injected ownership scope; plugins should not set this directly. */
    ownerPluginId?: string;
  }): Promise<void>;
  unregister(input: {
    attachmentId: string;
    resourceType: string;
    resourceId: string;
    field?: string;
    ownerPluginId?: string;
  }): Promise<void>;
  unregisterResource(resourceType: string, resourceId: string, ownerPluginId?: string): Promise<void>;
}
