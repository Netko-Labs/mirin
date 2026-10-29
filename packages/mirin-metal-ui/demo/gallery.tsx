/**
 * Gallery of every metal-ui component, written the way a shadcn app is
 * written: `className` strings and the same component names and props.
 *
 * 1. cd crates/mirin-metal && cargo build --bin mirin-metal-host
 * 2. cd packages/mirin-metal-ui && bun demo/gallery.tsx
 */

import { render, spawnNativeHost } from "@mirinjs/metal";
import { useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  Avatar,
  AvatarFallback,
  Badge,
  Box,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Kbd,
  KbdGroup,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  ThemeProvider,
  Toggle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Txt,
} from "../src/index.ts";

export function Gallery() {
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [fruit, setFruit] = useState<string | undefined>();
  const [plan, setPlan] = useState("pro");
  const [lastAction, setLastAction] = useState("none");

  return (
    <ThemeProvider>
      <ScrollArea className="flex-1 p-6 gap-6">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink>mirin</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>metal-ui gallery</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <Box className="flex flex-row flex-wrap items-center gap-2">
          <Button onClick={() => setLastAction("default")} testID="btn-default">
            Default
          </Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button disabled>Disabled</Button>
          <Badge>Badge</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </Box>
        <Txt className="text-xs text-muted-foreground">{`last action: ${lastAction}`}</Txt>

        <Box className="flex flex-row gap-6 items-start">
          <Card className="w-[360px]">
            <CardHeader>
              <CardTitle>Create project</CardTitle>
              <CardDescription>Deploy your new project in one-click.</CardDescription>
            </CardHeader>
            <CardContent>
              <Box className="flex flex-col gap-1.5">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChangeText={setName}
                  placeholder="Name of your project"
                  testID="name"
                />
              </Box>
              <Box className="flex flex-col gap-1.5">
                <Label>Framework</Label>
                <Select value={fruit} onValueChange={setFruit}>
                  <SelectTrigger testID="framework">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="next">Next.js</SelectItem>
                    <SelectItem value="sveltekit">SvelteKit</SelectItem>
                    <SelectItem value="astro">Astro</SelectItem>
                  </SelectContent>
                </Select>
              </Box>
              <Box className="flex flex-col gap-1.5">
                <Label>Notes</Label>
                <Textarea
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Type your message here."
                />
              </Box>
              <Box className="flex flex-row items-center gap-2">
                <Checkbox checked={checked} onCheckedChange={setChecked} testID="terms" />
                <Label>Accept terms and conditions</Label>
              </Box>
              <Box className="flex flex-row items-center gap-2">
                <Switch checked={on} onCheckedChange={setOn} testID="airplane" />
                <Label>Airplane mode</Label>
              </Box>
              <RadioGroup value={plan} onValueChange={setPlan}>
                <Box className="flex flex-row items-center gap-2">
                  <RadioGroupItem value="free" />
                  <Label>Free</Label>
                </Box>
                <Box className="flex flex-row items-center gap-2">
                  <RadioGroupItem value="pro" />
                  <Label>Pro</Label>
                </Box>
              </RadioGroup>
            </CardContent>
            <CardFooter className="justify-between">
              <Button variant="outline">Cancel</Button>
              <Button>Deploy</Button>
            </CardFooter>
          </Card>

          <Box className="flex flex-col gap-4 flex-1">
            <Tabs defaultValue="account">
              <TabsList>
                <TabsTrigger value="account">Account</TabsTrigger>
                <TabsTrigger value="password">Password</TabsTrigger>
              </TabsList>
              <TabsContent value="account">
                <Alert>
                  <AlertTitle>Heads up!</AlertTitle>
                  <AlertDescription>
                    You can add components to your app using the CLI.
                  </AlertDescription>
                </Alert>
              </TabsContent>
              <TabsContent value="password">
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>
                    Your session has expired. Please log in again.
                  </AlertDescription>
                </Alert>
              </TabsContent>
            </Tabs>

            <Box className="flex flex-row items-center gap-3">
              <Avatar>
                <AvatarFallback>CN</AvatarFallback>
              </Avatar>
              <Progress value={62} className="w-48" />
              <Skeleton className="w-24" />
              <Toggle pressed={pressed} onPressedChange={setPressed} variant="outline">
                Bold
              </Toggle>
              <KbdGroup>
                <Kbd>Ctrl</Kbd>
                <Kbd>K</Kbd>
              </KbdGroup>
            </Box>
            <Separator />

            <Box className="flex flex-row items-center gap-2">
              <Dialog>
                <DialogTrigger testID="open-dialog">
                  <Button variant="outline">Open dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Edit profile</DialogTitle>
                    <DialogDescription>Make changes to your profile here.</DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button onClick={() => setLastAction("dialog-save")} testID="dialog-save">
                      Save changes
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <AlertDialog>
                <AlertDialogTrigger testID="open-alert">
                  <Button variant="destructive">Delete</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                    <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => setLastAction("deleted")}>
                      Continue
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Sheet>
                <SheetTrigger testID="open-sheet">
                  <Button variant="outline">Open sheet</Button>
                </SheetTrigger>
                <SheetContent>
                  <SheetHeader>
                    <SheetTitle>Settings</SheetTitle>
                    <SheetDescription>Adjust your preferences.</SheetDescription>
                  </SheetHeader>
                </SheetContent>
              </Sheet>
              <Popover>
                <PopoverTrigger testID="open-popover">
                  <Button variant="outline">Popover</Button>
                </PopoverTrigger>
                <PopoverContent>
                  <Txt className="font-medium">Dimensions</Txt>
                  <Txt className="text-sm text-muted-foreground">
                    Set the dimensions for the layer.
                  </Txt>
                </PopoverContent>
              </Popover>
              <DropdownMenu>
                <DropdownMenuTrigger testID="open-menu">
                  <Button variant="outline">Menu</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>My Account</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setLastAction("profile")} testID="menu-profile">
                    Profile
                  </DropdownMenuItem>
                  <DropdownMenuItem>Billing</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive">Log out</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger testID="tooltip-trigger">
                  <Button variant="ghost">Hover me</Button>
                </TooltipTrigger>
                <TooltipContent>Add to library</TooltipContent>
              </Tooltip>
            </Box>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead width={120}>Invoice</TableHead>
                  <TableHead width={120}>Status</TableHead>
                  <TableHead width={140}>Method</TableHead>
                  <TableHead width={100} className="justify-end">
                    Amount
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[
                  ["INV001", "Paid", "Credit Card", "$250.00"],
                  ["INV002", "Pending", "PayPal", "$150.00"],
                  ["INV003", "Unpaid", "Bank Transfer", "$350.00"],
                ].map(([invoice, status, method, amount]) => (
                  <TableRow key={invoice}>
                    <TableCell width={120} className="font-medium">
                      {invoice}
                    </TableCell>
                    <TableCell width={120}>{status}</TableCell>
                    <TableCell width={140}>{method}</TableCell>
                    <TableCell width={100} className="justify-end">
                      {amount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Box>
      </ScrollArea>
    </ThemeProvider>
  );
}

if (import.meta.main) {
  const binary =
    Bun.argv[2] ??
    new URL("../../../crates/mirin-metal/target/debug/mirin-metal-host", import.meta.url).pathname;
  process.env.MIRIN_METAL_TITLE = "metal-ui gallery";
  process.env.MIRIN_METAL_SIZE ??= "1280x900";
  const transport = spawnNativeHost(binary);
  const root = render(<Gallery />, transport);
  transport.onClose(() => {
    root.unmount();
    process.exit(0);
  });
}
