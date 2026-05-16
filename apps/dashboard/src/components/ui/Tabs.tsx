import React from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '@utils/index';

export const Tabs = RadixTabs.Root;

interface TabsListProps extends React.ComponentPropsWithoutRef<typeof RadixTabs.List> {
  variant?: 'underline' | 'pills';
}

export const TabsList = React.forwardRef<React.ElementRef<typeof RadixTabs.List>, TabsListProps>(
  ({ className, variant = 'underline', ...rest }, ref) => (
    <RadixTabs.List
      ref={ref}
      className={cn(
        variant === 'underline'
          ? 'flex gap-1 border-b border-white/[0.06]'
          : 'flex gap-1 p-1 rounded-xl bg-gray-800/60 border border-white/[0.06]',
        className,
      )}
      {...rest}
    />
  ),
);
TabsList.displayName = 'TabsList';

interface TabsTriggerProps extends React.ComponentPropsWithoutRef<typeof RadixTabs.Trigger> {
  variant?: 'underline' | 'pills';
}

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof RadixTabs.Trigger>,
  TabsTriggerProps
>(({ className, variant = 'underline', ...rest }, ref) => (
  <RadixTabs.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center gap-2 text-sm font-medium transition-all duration-150',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50',
      'disabled:pointer-events-none disabled:opacity-50',
      variant === 'underline'
        ? [
            'px-3 py-2.5 text-gray-500 border-b-2 border-transparent -mb-px',
            'hover:text-gray-300 hover:border-gray-600',
            'data-[state=active]:text-violet-400 data-[state=active]:border-violet-500',
          ]
        : [
            'px-3 py-1.5 text-gray-500 rounded-lg',
            'hover:text-gray-300',
            'data-[state=active]:bg-violet-600/20 data-[state=active]:text-violet-300 data-[state=active]:shadow-sm',
          ],
      className,
    )}
    {...rest}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof RadixTabs.Content>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.Content>
>(({ className, ...rest }, ref) => (
  <RadixTabs.Content
    ref={ref}
    className={cn(
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50',
      className,
    )}
    {...rest}
  />
));
TabsContent.displayName = 'TabsContent';
